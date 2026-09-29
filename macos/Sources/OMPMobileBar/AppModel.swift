import AppKit
import Foundation
import SwiftUI

@MainActor
final class AppModel: ObservableObject {
    enum PairingState {
        case idle
        case loading
        case ready(AdminPairing)
        case connected(String)
        case failed(String)
    }

    @Published private(set) var serverState: ServerState = .offline("Connecting…")
    @Published private(set) var pairingState: PairingState = .idle

    let client: AdminClient
    private var pollingTask: Task<Void, Never>?
    private var pairingPanel: NSPanel?

    init(client: AdminClient = AdminClient()) {
        self.client = client
        pollingTask = Task { [weak self] in
            await self?.poll()
        }
        if ProcessInfo.processInfo.environment["OMP_MOBILE_OPEN_PAIRING"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                self?.showPairing()
            }
        }
    }

    deinit {
        pollingTask?.cancel()
    }

    var status: AdminStatus? {
        guard case .online(let status) = serverState else { return nil }
        return status
    }

    func refresh() async {
        do {
            let status = try await client.status()
            serverState = .online(status)
            if case .ready(let pairing) = pairingState,
               let consumed = status.pairings.first(where: { $0.id == pairing.id })?.consumedBy {
                pairingState = .connected(consumed.name)
            }
        } catch {
            serverState = .offline(error.localizedDescription)
        }
        updateMenuBarAccessibility()
    }

    func showPairing() {
        if let pairingPanel {
            pairingPanel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let view = PairingView(model: self)
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 570),
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "Connect a device"
        panel.isReleasedWhenClosed = false
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.center()
        panel.contentViewController = NSHostingController(rootView: view)
        pairingPanel = panel
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        requestPairing()
    }

    func requestPairing() {
        pairingState = .loading
        Task {
            do {
                pairingState = .ready(try await client.createPairing())
            } catch {
                pairingState = .failed(error.localizedDescription)
            }
        }
    }

    func removeDevice(_ id: String) {
        Task {
            do {
                try await client.removeDevice(id: id)
                await refresh()
            } catch {
                serverState = .offline(error.localizedDescription)
            }
        }
    }

    func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }

    func openLogs() {
        let logs = client.home.appendingPathComponent("logs", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        NSWorkspace.shared.open(logs)
    }

    func restartServer() {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = [
            "kickstart", "-k",
            "gui/\(getuid())/com.heyskylark.omp-mobile.server",
        ]
        try? process.run()
    }

    private func updateMenuBarAccessibility() {
        // MenuBarExtra does not forward SwiftUI's accessibility value to its NSStatusBarButton.
        let value = serverState.menuBarMark.accessibilityValue
        for window in NSApp.windows where window.level == .statusBar {
            updateMenuBarAccessibility(in: window.contentView, value: value)
        }
    }

    private func updateMenuBarAccessibility(in view: NSView?, value: String) {
        guard let view else { return }
        if let button = view as? NSButton {
            button.setAccessibilityLabel("OMP Mobile")
            button.setAccessibilityValue(value)
        }
        for subview in view.subviews {
            updateMenuBarAccessibility(in: subview, value: value)
        }
    }

    private func poll() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(for: .seconds(5))
        }
    }
}
