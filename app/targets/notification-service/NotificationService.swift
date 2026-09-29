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
  case malformedEnvelope
  case missingMachine
  case invalidKey
  case invalidPlaintext
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

    do {
      let userInfo = request.content.userInfo
      guard let machineId = userInfo["m"] as? String,
            let envelope = userInfo["e"] as? [String: Any],
            let nonceBase64 = envelope["n"] as? String,
            let sealedBase64 = envelope["c"] as? String,
            let nonceData = Data(base64Encoded: nonceBase64),
            let sealedData = Data(base64Encoded: sealedBase64),
            sealedData.count >= 16 else {
        throw NotificationDecryptError.malformedEnvelope
      }
      guard let machine = try KeychainMachineVault.machine(id: machineId) else {
        throw NotificationDecryptError.missingMachine
      }
      guard machine.machineId == machineId else {
        throw NotificationDecryptError.missingMachine
      }
      guard let keyData = Data(base64Encoded: machine.pushKey), keyData.count == 32 else {
        throw NotificationDecryptError.invalidKey
      }

      let ciphertext = sealedData.dropLast(16)
      let tag = sealedData.suffix(16)
      let box = try AES.GCM.SealedBox(
        nonce: AES.GCM.Nonce(data: nonceData),
        ciphertext: ciphertext,
        tag: tag
      )
      let plaintextData = try AES.GCM.open(
        box,
        using: SymmetricKey(data: keyData),
        authenticating: Data(machineId.utf8)
      )
      let plaintext = try JSONDecoder().decode(PushPlaintext.self, from: plaintextData)
      guard plaintext.v == 1,
            plaintext.machineId == machineId,
            !plaintext.sessionId.isEmpty,
            ["OMP_APPROVAL", "OMP_QUESTION", "OMP_INFO"].contains(plaintext.category) else {
        throw NotificationDecryptError.invalidPlaintext
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
      finish(content)
    } catch {
      finish(request.content)
    }
  }

  override func serviceExtensionTimeWillExpire() {
    finish(originalContent)
  }

  private func finish(_ content: UNNotificationContent?) {
    guard let handler = contentHandler, let content else { return }
    contentHandler = nil
    handler(content)
  }
}

private enum KeychainMachineVault {
  private static let service = "omp-mobile.machine"

  static func machine(id: String) throws -> MachineRecord? {
    let decoder = JSONDecoder()
    if let data = try copy(id: id, accessGroup: accessGroup) {
      return try decoder.decode(MachineRecord.self, from: data)
    }
    return nil
  }

  private static var accessGroup: String? {
    guard let prefix = Bundle.main.object(forInfoDictionaryKey: "OmpAppIdentifierPrefix") as? String,
          let extensionBundleId = Bundle.main.bundleIdentifier,
          extensionBundleId.hasSuffix(".notification-service") else { return nil }
    return prefix + extensionBundleId.dropLast(".notification-service".count) + ".shared"
  }

  private static func copy(id: String, accessGroup: String?) throws -> Data? {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: id,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne
    ]
    if let accessGroup, !accessGroup.isEmpty { query[kSecAttrAccessGroup as String] = accessGroup }
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    if status == errSecMissingEntitlement, accessGroup != nil {
      NSLog("OMP Mobile NSE: shared keychain group unavailable; trying the default keychain group")
      return try copy(id: id, accessGroup: nil)
    }
    guard status == errSecSuccess, let data = result as? Data else {
      throw NSError(domain: NSOSStatusErrorDomain, code: Int(status))
    }
    return data
  }
}
