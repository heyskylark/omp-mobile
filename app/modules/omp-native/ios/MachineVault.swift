import Foundation
import Security

struct MachineRecord: Codable {
  let machineId: String
  var name: String
  let url: String
  let deviceId: String
  let token: String
  let pairedAt: String
  let pushKey: String

  var publicDictionary: [String: String] {
    [
      "machineId": machineId,
      "name": name,
      "url": url,
      "deviceId": deviceId,
      "token": token,
      "pairedAt": pairedAt
    ]
  }
}

enum MachineVaultError: LocalizedError {
  case invalidRecord
  case keychain(OSStatus)

  var errorDescription: String? {
    switch self {
    case .invalidRecord:
      return "Machine record is invalid"
    case .keychain(let status):
      return SecCopyErrorMessageString(status, nil) as String? ?? "Keychain error \(status)"
    }
  }
}

final class MachineVault: @unchecked Sendable {
  static let shared = MachineVault()
  static let service = "omp-mobile.machine"

  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()
  private let lock = NSLock()
  private var didLogFallback = false

  private var configuredAccessGroup: String? {
    Bundle.main.object(forInfoDictionaryKey: "OmpKeychainAccessGroup") as? String
  }

  func list() throws -> [MachineRecord] {
    try lock.withLock {
      let result = try copyAll(useAccessGroup: true)
      return try result.map { try decoder.decode(MachineRecord.self, from: $0) }
        .sorted { $0.pairedAt > $1.pairedAt }
    }
  }

  func get(machineId: String) throws -> MachineRecord? {
    try lock.withLock {
      guard let data = try copyOne(machineId: machineId, useAccessGroup: true) else { return nil }
      return try decoder.decode(MachineRecord.self, from: data)
    }
  }

  func save(_ record: MachineRecord) throws {
    let data = try encoder.encode(record)
    try lock.withLock {
      let status = upsert(machineId: record.machineId, data: data, useAccessGroup: true)
      if status == errSecSuccess { return }
      if shouldFallback(status) {
        logFallbackOnce()
        let fallbackStatus = upsert(machineId: record.machineId, data: data, useAccessGroup: false)
        guard fallbackStatus == errSecSuccess else { throw MachineVaultError.keychain(fallbackStatus) }
        return
      }
      throw MachineVaultError.keychain(status)
    }
  }

  func remove(machineId: String) throws {
    try lock.withLock {
      let status = SecItemDelete(baseQuery(machineId: machineId, useAccessGroup: true) as CFDictionary)
      if status == errSecSuccess || status == errSecItemNotFound { return }
      if shouldFallback(status) {
        logFallbackOnce()
        let fallbackStatus = SecItemDelete(baseQuery(machineId: machineId, useAccessGroup: false) as CFDictionary)
        guard fallbackStatus == errSecSuccess || fallbackStatus == errSecItemNotFound else {
          throw MachineVaultError.keychain(fallbackStatus)
        }
        return
      }
      throw MachineVaultError.keychain(status)
    }
  }

  private func copyOne(machineId: String, useAccessGroup: Bool) throws -> Data? {
    var query = baseQuery(machineId: machineId, useAccessGroup: useAccessGroup)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return nil }
    if shouldFallback(status), useAccessGroup {
      logFallbackOnce()
      return try copyOne(machineId: machineId, useAccessGroup: false)
    }
    guard status == errSecSuccess, let data = result as? Data else {
      throw MachineVaultError.keychain(status)
    }
    return data
  }

  private func copyAll(useAccessGroup: Bool) throws -> [Data] {
    var query = baseQuery(machineId: nil, useAccessGroup: useAccessGroup)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitAll
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    if shouldFallback(status), useAccessGroup {
      logFallbackOnce()
      return try copyAll(useAccessGroup: false)
    }
    guard status == errSecSuccess else { throw MachineVaultError.keychain(status) }
    if let values = result as? [Data] { return values }
    if let value = result as? Data { return [value] }
    return []
  }

  private func baseQuery(machineId: String?, useAccessGroup: Bool) -> [String: Any] {
    var query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service
    ]
    if let machineId { query[kSecAttrAccount as String] = machineId }
    if useAccessGroup, let group = configuredAccessGroup, !group.isEmpty {
      query[kSecAttrAccessGroup as String] = group
    }
    return query
  }

  private func shouldFallback(_ status: OSStatus) -> Bool {
    status == errSecMissingEntitlement && configuredAccessGroup != nil
  }

  private func upsert(machineId: String, data: Data, useAccessGroup: Bool) -> OSStatus {
    var query = baseQuery(machineId: machineId, useAccessGroup: useAccessGroup)
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    guard status == errSecItemNotFound else { return status }
    query[kSecValueData as String] = data
    return SecItemAdd(query as CFDictionary, nil)
  }


  private func logFallbackOnce() {
    guard !didLogFallback else { return }
    didLogFallback = true
    NSLog("OMP Mobile: shared keychain access group is unavailable; using the app's default keychain group")
  }
}
