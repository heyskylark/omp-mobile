import ExpoModulesCore
import Foundation
import UIKit
import UserNotifications

extension Notification.Name {
  static let ompNotificationOpen = Notification.Name("OmpNative.notificationOpen")
  static let ompActionResult = Notification.Name("OmpNative.actionResult")
}

private enum OmpAction: String {
  case approve = "APPROVE"
  case deny = "DENY"
  case reply = "REPLY"

  var response: [String: Any] {
    switch self {
    case .approve: return ["kind": "approve"]
    case .deny: return ["kind": "deny"]
    case .reply: return [:]
    }
  }
}

final class OmpNotificationCoordinator: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
  static let shared = OmpNotificationCoordinator()

  private let stateLock = NSLock()
  private var launchOpen: [String: Any]?
  private var registrations: [([String: String]?) -> Void] = []

  func install() {
    let center = UNUserNotificationCenter.current()
    center.delegate = self
    center.setNotificationCategories(Self.categories)
  }

  func registerForPush(completion: @escaping ([String: String]?) -> Void) {
    install()
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
      guard granted else {
        DispatchQueue.main.async { completion(nil) }
        return
      }
      DispatchQueue.main.async {
        let startsRegistration = self.stateLock.withLock { () -> Bool in
          let startsRegistration = self.registrations.isEmpty
          self.registrations.append(completion)
          return startsRegistration
        }
        guard startsRegistration else { return }
        UIApplication.shared.registerForRemoteNotifications()
        DispatchQueue.main.asyncAfter(deadline: .now() + 15) {
          self.finishRegistration(nil)
        }
      }
    }
  }

  func registered(deviceToken: Data) {
    let token = deviceToken.map { String(format: "%02x", $0) }.joined()
    #if DEBUG
    let environment = "sandbox"
    #else
    let environment = "production"
    #endif
    finishRegistration(["token": token, "environment": environment])
  }

  func registrationFailed() {
    finishRegistration(nil)
  }

  func captureLaunch(userInfo: [AnyHashable: Any]) {
    guard let open = Self.notificationOpen(userInfo: userInfo) else { return }
    record(open: open)
  }

  func consumeLaunchOpen() -> [String: Any]? {
    stateLock.withLock {
      defer { launchOpen = nil }
      return launchOpen
    }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .sound])
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter,
    didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    let userInfo = response.notification.request.content.userInfo
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier || response.actionIdentifier == "OPEN" {
      if let open = Self.notificationOpen(userInfo: userInfo) { record(open: open) }
      completionHandler()
      return
    }

    guard let action = OmpAction(rawValue: response.actionIdentifier),
          let machineId = Self.string("machineId", fallback: "m", in: userInfo),
          let sessionId = Self.string("sessionId", in: userInfo),
          let interactionId = Self.string("interactionId", in: userInfo) else {
      completionHandler()
      return
    }

    var interactionResponse = action.response
    if action == .reply {
      guard let textResponse = response as? UNTextInputNotificationResponse else {
        completionHandler()
        return
      }
      interactionResponse = ["kind": "text", "text": textResponse.userText]
    }

    performResponse(
      machineId: machineId,
      sessionId: sessionId,
      interactionId: interactionId,
      operationId: "\(response.notification.request.identifier):\(response.actionIdentifier)",
      action: action,
      response: interactionResponse,
      completion: completionHandler
    )
  }

  private func performResponse(
    machineId: String,
    sessionId: String,
    interactionId: String,
    operationId: String,
    action: OmpAction,
    response: [String: Any],
    completion: @escaping () -> Void
  ) {
    let backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "OMP notification action")
    let finish: (MachineRecord?, String?) -> Void = { machine, error in
      var result: [String: Any] = [
        "machineId": machineId,
        "sessionId": sessionId,
        "interactionId": interactionId,
        "action": action.rawValue,
        "ok": error == nil
      ]
      if let error { result["message"] = error }
      DispatchQueue.main.async {
        NotificationCenter.default.post(name: .ompActionResult, object: nil, userInfo: result)
        if let error {
          self.postFailure(machineName: machine?.name ?? machineId, detail: error)
        }
        if backgroundTask != .invalid { UIApplication.shared.endBackgroundTask(backgroundTask) }
        completion()
      }
    }

    let machine: MachineRecord
    do {
      guard let stored = try MachineVault.shared.get(machineId: machineId) else {
        finish(nil, "Paired machine not found")
        return
      }
      machine = stored
    } catch {
      finish(nil, error.localizedDescription)
      return
    }

    guard let baseURL = URL(string: machine.url),
          var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false),
          components.scheme == "http" || components.scheme == "https" else {
      finish(machine, "Machine URL is invalid")
      return
    }
    let basePath = components.path
    components.path = basePath + "/v1/sessions/" + Self.encodePath(sessionId)
      + "/interactions/" + Self.encodePath(interactionId) + "/respond"
    guard let url = components.url else {
      finish(machine, "Machine URL is invalid")
      return
    }

    let body: Data
    do {
      body = try JSONSerialization.data(withJSONObject: ["operationId": operationId, "response": response])
    } catch {
      finish(machine, error.localizedDescription)
      return
    }

    var request = URLRequest(url: url, timeoutInterval: 15)
    request.httpMethod = "POST"
    request.httpBody = body
    request.setValue("application/json", forHTTPHeaderField: "content-type")
    request.setValue("Bearer \(machine.token)", forHTTPHeaderField: "authorization")
    URLSession.shared.dataTask(with: request) { _, response, error in
      if let error { finish(machine, error.localizedDescription); return }
      guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
        finish(machine, "Server rejected the response")
        return
      }
      finish(machine, nil)
    }.resume()
  }

  private func record(open: [String: Any]) {
    stateLock.withLock { launchOpen = open }
    DispatchQueue.main.async {
      NotificationCenter.default.post(name: .ompNotificationOpen, object: nil, userInfo: open)
    }
  }

  private func finishRegistration(_ value: [String: String]?) {
    let completions = stateLock.withLock { () -> [([String: String]?) -> Void] in
      defer { registrations.removeAll() }
      return registrations
    }
    guard !completions.isEmpty else { return }
    DispatchQueue.main.async {
      for completion in completions { completion(value) }
    }
  }

  private func postFailure(machineName: String, detail: String) {
    let content = UNMutableNotificationContent()
    content.title = "Couldn't reach \(machineName)"
    content.body = detail
    content.sound = .default
    let request = UNNotificationRequest(identifier: "omp-action-failed-\(UUID().uuidString)", content: content, trigger: nil)
    UNUserNotificationCenter.current().add(request)
  }

  private static func notificationOpen(userInfo: [AnyHashable: Any]) -> [String: Any]? {
    guard let machineId = string("machineId", fallback: "m", in: userInfo),
          let sessionId = string("sessionId", in: userInfo) else { return nil }
    var open: [String: Any] = ["machineId": machineId, "sessionId": sessionId]
    if let interactionId = string("interactionId", in: userInfo) { open["interactionId"] = interactionId }
    return open
  }

  private static func string(_ key: String, fallback: String? = nil, in values: [AnyHashable: Any]) -> String? {
    if let value = values[key] as? String, !value.isEmpty { return value }
    if let fallback, let value = values[fallback] as? String, !value.isEmpty { return value }
    return nil
  }

  private static func encodePath(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? value
  }

  private static var categories: Set<UNNotificationCategory> {
    let approve = UNNotificationAction(identifier: "APPROVE", title: "Approve", options: [.authenticationRequired])
    let deny = UNNotificationAction(identifier: "DENY", title: "Deny", options: [.destructive])
    let reply = UNTextInputNotificationAction(
      identifier: "REPLY",
      title: "Reply",
      options: [],
      textInputButtonTitle: "Send",
      textInputPlaceholder: "Reply"
    )
    let open = UNNotificationAction(identifier: "OPEN", title: "Open", options: [.foreground])
    return [
      UNNotificationCategory(identifier: "OMP_APPROVAL", actions: [approve, deny], intentIdentifiers: [], options: []),
      UNNotificationCategory(identifier: "OMP_QUESTION", actions: [reply, open], intentIdentifiers: [], options: []),
      UNNotificationCategory(identifier: "OMP_INFO", actions: [], intentIdentifiers: [], options: [])
    ]
  }
}

public final class OmpNativeAppDelegateSubscriber: ExpoAppDelegateSubscriber {
  public func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    OmpNotificationCoordinator.shared.install()
    _ = OmpImagePaste.install
    if let userInfo = launchOptions?[.remoteNotification] as? [AnyHashable: Any] {
      OmpNotificationCoordinator.shared.captureLaunch(userInfo: userInfo)
    }
    return true
  }

  public func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
    OmpNotificationCoordinator.shared.registered(deviceToken: deviceToken)
  }

  public func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
    NSLog("OMP Mobile: APNs registration failed: %@", error.localizedDescription)
    OmpNotificationCoordinator.shared.registrationFailed()
  }
}
