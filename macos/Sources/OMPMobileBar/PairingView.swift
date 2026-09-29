import CoreImage
import CoreImage.CIFilterBuiltins
import SwiftUI

struct PairingView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        VStack(spacing: 18) {
            VStack(spacing: 5) {
                Image(systemName: "iphone.and.arrow.forward")
                    .font(.system(size: 30, weight: .medium))
                    .foregroundStyle(.tint)
                Text("Connect your iPhone")
                    .font(.title2.weight(.semibold))
                Text("Scan with the OMP app on your iPhone")
                    .foregroundStyle(.secondary)
            }

            pairingContent
        }
        .padding(28)
        .frame(width: 420, height: 570)
        .background(.background)
    }

    @ViewBuilder
    private var pairingContent: some View {
        switch model.pairingState {
        case .idle, .loading:
            Spacer()
            ProgressView("Creating a secure one-time code…")
            Spacer()
        case .failed(let message):
            Spacer()
            ContentUnavailableView(
                "Couldn’t create a code",
                systemImage: "exclamationmark.triangle",
                description: Text(message)
            )
            Button("Try Again") { model.requestPairing() }
                .buttonStyle(.borderedProminent)
            Spacer()
        case .ready(let pairing):
            readyContent(pairing)
        }
    }

    private func readyContent(_ pairing: AdminPairing) -> some View {
        VStack(spacing: 16) {
            if let image = QRCode.image(for: pairing.pairingUrl) {
                Image(nsImage: image)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 230, height: 230)
                    .padding(12)
                    .background(.white, in: RoundedRectangle(cornerRadius: 16))
                    .shadow(color: .black.opacity(0.08), radius: 12, y: 4)
                    .accessibilityLabel("Pairing QR code")
            }

            VStack(spacing: 5) {
                Text(pairing.code)
                    .font(.system(size: 28, weight: .semibold, design: .monospaced))
                    .textSelection(.enabled)
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(expirationText(pairing, now: context.date))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }

            HStack(spacing: 10) {
                Button {
                    model.copy(pairing.pairingUrl)
                } label: {
                    Label("Copy link", systemImage: "doc.on.doc")
                }
                .buttonStyle(.bordered)

                Button {
                    model.requestPairing()
                } label: {
                    Label("New code", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.borderedProminent)
            }

            Text("This code can be used once and expires after 10 minutes.")
                .font(.caption)
                .foregroundStyle(.tertiary)
        }
    }

    private func expirationText(_ pairing: AdminPairing, now: Date) -> String {
        let seconds = max(0, Int(pairing.expiration.timeIntervalSince(now)))
        if seconds == 0 { return "Expired — create a new code" }
        return String(format: "Expires in %d:%02d", seconds / 60, seconds % 60)
    }
}

enum QRCode {
    private static let context = CIContext(options: [.useSoftwareRenderer: false])

    static func image(for value: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(value.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }

        let scale = floor(230 / output.extent.width)
        let transformed = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        guard let cgImage = context.createCGImage(transformed, from: transformed.extent) else {
            return nil
        }
        return NSImage(cgImage: cgImage, size: NSSize(width: 230, height: 230))
    }
}
