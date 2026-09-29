import AppKit
import SwiftUI

struct MenuContentView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Divider()
            statusContent
            Divider()
            actions
        }
        .frame(width: 340)
        .task { await model.refresh() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(model.status?.machineName ?? "OMP Mobile")
                .font(.headline)
            if let url = model.status?.url {
                Button {
                    model.copy(url)
                } label: {
                    HStack(spacing: 5) {
                        Text(url)
                            .lineLimit(1)
                        Image(systemName: "doc.on.doc")
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Copy server URL")
            }
        }
        .padding(16)
    }

    @ViewBuilder
    private var statusContent: some View {
        switch model.serverState {
        case .offline(let reason):
            Label {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Server offline")
                        .fontWeight(.medium)
                    Text(reason)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            } icon: {
                Image(systemName: "bolt.slash.fill")
                    .foregroundStyle(.red)
            }
            .padding(16)
        case .online(let status):
            VStack(alignment: .leading, spacing: 13) {
                HStack(spacing: 0) {
                    CountView(value: status.live.terminal, label: "Terminal")
                    CountView(value: status.live.server, label: "Server")
                    CountView(value: status.live.pending, label: "Waiting", emphasized: status.live.pending > 0)
                }
                if !status.apnsConfigured {
                    ProblemRow(text: "Push notifications are not configured")
                }
                ForEach(status.problems, id: \.self) { problem in
                    ProblemRow(text: problem)
                }
                devices(status.devices)
            }
            .padding(16)
        }
    }

    private func devices(_ devices: [AdminStatus.Device]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("PAIRED DEVICES")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
            if devices.isEmpty {
                Text("No devices paired")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(devices) { device in
                    HStack {
                        Image(systemName: "iphone")
                            .foregroundStyle(.secondary)
                        Text(device.name)
                            .lineLimit(1)
                        Spacer()
                        Button("Remove", role: .destructive) {
                            model.removeDevice(device.id)
                        }
                        .buttonStyle(.borderless)
                        .font(.caption)
                    }
                }
            }
        }
    }

    private var actions: some View {
        VStack(spacing: 2) {
            ActionButton(title: "Connect a device…", symbol: "qrcode") {
                model.showPairing()
            }
            ActionButton(title: "Restart server", symbol: "arrow.clockwise") {
                model.restartServer()
            }
            ActionButton(title: "Open logs", symbol: "doc.text.magnifyingglass") {
                model.openLogs()
            }
            Divider().padding(.vertical, 4)
            ActionButton(title: "Quit OMP Mobile", symbol: "power") {
                NSApplication.shared.terminate(nil)
            }
        }
        .padding(8)
    }
}

private struct CountView: View {
    let value: Int
    let label: String
    var emphasized = false

    var body: some View {
        VStack(spacing: 2) {
            Text(value.formatted())
                .font(.title3.weight(.semibold))
                .foregroundStyle(emphasized ? Color.orange : Color.primary)
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
    }
}

private struct ProblemRow: View {
    let text: String

    var body: some View {
        Label(text, systemImage: "exclamationmark.triangle.fill")
            .font(.caption)
            .foregroundStyle(.orange)
            .fixedSize(horizontal: false, vertical: true)
    }
}

private struct ActionButton: View {
    let title: String
    let symbol: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
                .padding(.horizontal, 8)
                .padding(.vertical, 6)
        }
        .buttonStyle(.plain)
    }
}
