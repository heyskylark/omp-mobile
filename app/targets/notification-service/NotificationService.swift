import CryptoKit
import Foundation
import Security
import UserNotifications

private struct MachineRecord: Decodable {
  let machineId: String
  let pushKey: String
}

private struct PushPlaintext: Decodable {
  let v: Int
  let machineId: String
  let sessionId: String
  let interactionId: String?
  let category: String
  let title: String
  let body: String
}

private enum NotificationDecryptError: Error {
  case malformedEnvelope(String)
  case missingMachine(String)
  case keychain(OSStatus)
  case invalidKey(String)
  case decryptFailed(String)
  case invalidPlaintext(String)
  case unexpected(String)

  var step: String {
    switch self {
    case .malformedEnvelope: return "malformedEnvelope"
    case .missingMachine: return "missingMachine"
    case .keychain: return "keychain"
    case .invalidKey: return "invalidKey"
    case .decryptFailed: return "decrypt"
    case .invalidPlaintext: return "invalidPlaintext"
    case .unexpected: return "unexpected"
    }
  }

  var detail: String {
    switch self {
    case .malformedEnvelope(let detail), .missingMachine(let detail), .invalidKey(let detail),
         .decryptFailed(let detail), .invalidPlaintext(let detail), .unexpected(let detail):
      return detail
    case .keychain(let status):
      let message = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
      return "OSStatus \(status): \(message)"
    }
  }
}

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var originalContent: UNNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    originalContent = request.content

    guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
      contentHandler(request.content)
      return
    }

    let userInfo = request.content.userInfo
    let machineId = userInfo["m"] as? String
    do {
      guard let machineId else { throw NotificationDecryptError.malformedEnvelope("no machine id (m)") }
      guard let envelope = userInfo["e"] as? [String: Any] else {
        throw NotificationDecryptError.malformedEnvelope("no envelope (e)")
      }
      guard let nonceData = (envelope["n"] as? String).flatMap({ Data(base64Encoded: $0) }) else {
        throw NotificationDecryptError.malformedEnvelope("nonce (e.n) is not base64")
      }
      guard let sealedData = (envelope["c"] as? String).flatMap({ Data(base64Encoded: $0) }),
            sealedData.count >= 16 else {
        throw NotificationDecryptError.malformedEnvelope("ciphertext (e.c) is not base64 of at least 16 bytes")
      }
      guard let machine = try KeychainMachineVault.machine(id: machineId), machine.machineId == machineId else {
        let stored = (try? KeychainMachineVault.machineIds()).map { $0.joined(separator: ", ") } ?? "unreadable"
        throw NotificationDecryptError.missingMachine("no key for computer \(machineId); stored: [\(stored)]")
      }
      guard let keyData = Data(base64Encoded: machine.pushKey), keyData.count == 32 else {
        throw NotificationDecryptError.invalidKey("stored push key is not 32 bytes of base64")
      }

      let plaintextData: Data
      do {
        let box = try AES.GCM.SealedBox(
          nonce: AES.GCM.Nonce(data: nonceData),
          ciphertext: sealedData.dropLast(16),
          tag: sealedData.suffix(16)
        )
        plaintextData = try AES.GCM.open(
          box,
          using: SymmetricKey(data: keyData),
          authenticating: Data(machineId.utf8)
        )
      } catch {
        throw NotificationDecryptError.decryptFailed(String(describing: error))
      }
      let plaintext: PushPlaintext
      do {
        plaintext = try JSONDecoder().decode(PushPlaintext.self, from: plaintextData)
      } catch {
        throw NotificationDecryptError.invalidPlaintext(String(describing: error))
      }
      guard plaintext.v == 1 else { throw NotificationDecryptError.invalidPlaintext("version \(plaintext.v)") }
      guard plaintext.machineId == machineId else {
        throw NotificationDecryptError.invalidPlaintext("sealed for computer \(plaintext.machineId)")
      }
      guard !plaintext.sessionId.isEmpty else { throw NotificationDecryptError.invalidPlaintext("empty session id") }
      guard ["OMP_APPROVAL", "OMP_QUESTION", "OMP_INFO"].contains(plaintext.category) else {
        throw NotificationDecryptError.invalidPlaintext("category \(plaintext.category)")
      }

      content.title = plaintext.title
      content.body = plaintext.body
      content.threadIdentifier = plaintext.sessionId
      content.categoryIdentifier = plaintext.category
      content.userInfo["machineId"] = machineId
      content.userInfo["sessionId"] = plaintext.sessionId
      if let interactionId = plaintext.interactionId {
        content.userInfo["interactionId"] = interactionId
      }
      NotificationDiagnostics.record(machineId: machineId, step: "decrypted", detail: plaintext.category, ok: true)
      finish(content)
    } catch {
      let failure = error as? NotificationDecryptError ?? .unexpected(String(describing: error))
      NSLog("OMP Mobile NSE: showing the placeholder; %@ failed: %@", failure.step, failure.detail)
      NotificationDiagnostics.record(machineId: machineId, step: failure.step, detail: failure.detail, ok: false)
      finish(request.content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    if contentHandler != nil {
      NSLog("OMP Mobile NSE: showing the placeholder; the extension ran out of time")
      NotificationDiagnostics.record(
        machineId: originalContent?.userInfo["m"] as? String,
        step: "timeout",
        detail: "the extension ran out of time",
        ok: false
      )
    }
    finish(originalContent)
  }

  private func finish(_ content: UNNotificationContent?) {
    guard let handler = contentHandler, let content else { return }
    contentHandler = nil
    handler(content)
  }
}

/// The containing app's bundle id, from this extension's `<app>.notification-service` bundle id.
private let appBundleId: String? = {
  guard let extensionBundleId = Bundle.main.bundleIdentifier,
        extensionBundleId.hasSuffix(".notification-service") else { return nil }
  return String(extensionBundleId.dropLast(".notification-service".count))
}()

/// Saves the latest outcome to the shared app group, where the app shows it in a computer's settings.
private enum NotificationDiagnostics {
  static func record(machineId: String?, step: String, detail: String, ok: Bool) {
    guard let appBundleId, let defaults = UserDefaults(suiteName: "group.\(appBundleId)") else { return }
    var result: [String: Any] = [
      "at": ISO8601DateFormatter().string(from: Date()),
      "ok": ok,
      "step": step,
      "detail": detail
    ]
    if let machineId { result["machineId"] = machineId }
    defaults.set(result, forKey: "omp.notificationService.lastResult")
  }
}

private enum KeychainMachineVault {
  private static let service = "omp-mobile.machine"

  static func machine(id: String) throws -> MachineRecord? {
    let item = try copy(baseQuery(account: id), returning: kSecReturnData, limit: kSecMatchLimitOne, accessGroup: accessGroup)
    guard let data = item as? Data else { return nil }
    do {
      return try JSONDecoder().decode(MachineRecord.self, from: data)
    } catch {
      throw NotificationDecryptError.invalidKey("stored record is not valid: \(error)")
    }
  }

  /// Accounts of every stored computer, to tell a missing record apart from a computer id that changed.
  static func machineIds() throws -> [String] {
    let items = try copy(baseQuery(account: nil), returning: kSecReturnAttributes, limit: kSecMatchLimitAll, accessGroup: accessGroup)
    let attributes = items as? [[String: Any]] ?? []
    return attributes.compactMap { $0[kSecAttrAccount as String] as? String }
  }

  private static var accessGroup: String? {
    guard let prefix = Bundle.main.object(forInfoDictionaryKey: "OmpAppIdentifierPrefix") as? String,
          let appBundleId else { return nil }
    return prefix + appBundleId + ".shared"
  }

  private static func baseQuery(account: String?) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service
    ]
    if let account { query[kSecAttrAccount as String] = account }
    return query
  }

  private static func copy(
    _ query: [String: Any],
    returning: CFString,
    limit: CFString,
    accessGroup: String?
  ) throws -> CFTypeRef? {
    var request = query
    request[returning as String] = true
    request[kSecMatchLimit as String] = limit
    if let accessGroup, !accessGroup.isEmpty { request[kSecAttrAccessGroup as String] = accessGroup }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(request as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    if status == errSecMissingEntitlement, accessGroup != nil {
      NSLog("OMP Mobile NSE: shared keychain group unavailable; trying the default keychain group")
      return try copy(query, returning: returning, limit: limit, accessGroup: nil)
    }
    guard status == errSecSuccess else { throw NotificationDecryptError.keychain(status) }
    return result
  }
}
