import ExpoModulesCore
import Foundation

private enum OmpNativeError: LocalizedError {
  case invalidField(String)

  var errorDescription: String? {
    switch self {
    case .invalidField(let field): return "Invalid machine field: \(field)"
    }
  }
}

public final class OmpNativeModule: Module {
  private var observers: [NSObjectProtocol] = []

  public func definition() -> ModuleDefinition {
    Name("OmpNative")
    Events("onNotificationOpen", "onActionResult")

    OnCreate {
      let center = NotificationCenter.default
      self.observers = [
        center.addObserver(forName: .ompNotificationOpen, object: nil, queue: .main) { [weak self] note in
          guard let payload = note.userInfo as? [String: Any] else { return }
          self?.sendEvent("onNotificationOpen", payload.mapValues { Optional($0) })
        },
        center.addObserver(forName: .ompActionResult, object: nil, queue: .main) { [weak self] note in
          guard let payload = note.userInfo as? [String: Any] else { return }
          self?.sendEvent("onActionResult", payload.mapValues { Optional($0) })
        }
      ]
    }

    OnDestroy {
      for observer in self.observers { NotificationCenter.default.removeObserver(observer) }
      self.observers.removeAll()
    }

    AsyncFunction("listMachines") {
      try MachineVault.shared.list().map(\.publicDictionary)
    }

    AsyncFunction("saveMachine") { (input: [String: String]) in
      let record = try Self.parseMachine(input)
      try MachineVault.shared.save(record)
    }

    AsyncFunction("removeMachine") { (machineId: String) in
      guard !machineId.isEmpty else { throw OmpNativeError.invalidField("machineId") }
      try MachineVault.shared.remove(machineId: machineId)
    }

    AsyncFunction("registerForPush") { (promise: Promise) in
      OmpNotificationCoordinator.shared.registerForPush { result in
        promise.resolve(result)
      }
    }.runOnQueue(.main)

    AsyncFunction("consumeLaunchNotification") {
      OmpNotificationCoordinator.shared.consumeLaunchOpen()
    }
  }

  private static func parseMachine(_ input: [String: String]) throws -> MachineRecord {
    func required(_ key: String) throws -> String {
      guard let value = input[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !value.isEmpty else {
        throw OmpNativeError.invalidField(key)
      }
      return value
    }

    let machineId = try required("machineId")
    let name = try required("name")
    let urlString = try required("url")
    guard let url = URL(string: urlString), url.host != nil, url.scheme == "http" || url.scheme == "https" else {
      throw OmpNativeError.invalidField("url")
    }
    let deviceId = try required("deviceId")
    let token = try required("token")
    let pairedAt = try required("pairedAt")
    guard Self.isISODate(pairedAt) else {
      throw OmpNativeError.invalidField("pairedAt")
    }
    let pushKey = try required("pushKey")
    guard Data(base64Encoded: pushKey)?.count == 32 else {
      throw OmpNativeError.invalidField("pushKey")
    }
    return MachineRecord(
      machineId: machineId,
      name: name,
      url: url.absoluteString,
      deviceId: deviceId,
      token: token,
      pairedAt: pairedAt,
      pushKey: pushKey
    )
  }

  private static func isISODate(_ value: String) -> Bool {
    let formatter = ISO8601DateFormatter()
    if formatter.date(from: value) != nil { return true }
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.date(from: value) != nil
  }
}
