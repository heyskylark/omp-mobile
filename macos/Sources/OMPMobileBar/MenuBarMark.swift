import AppKit

/// The OMP π drawn as an 18pt template image, with a corner badge for server state.
enum MenuBarMark: Sendable {
    case online
    case waiting
    case problem
    case offline

    var accessibilityValue: String {
        switch self {
        case .online: "Online"
        case .waiting: "Waiting"
        case .problem: "Warning"
        case .offline: "Offline"
        }
    }

    @MainActor var image: NSImage {
        switch self {
        case .online: Self.onlineImage
        case .waiting: Self.waitingImage
        case .problem: Self.problemImage
        case .offline: Self.offlineImage
        }
    }

    @MainActor private static let onlineImage = render(.online)
    @MainActor private static let waitingImage = render(.waiting)
    @MainActor private static let problemImage = render(.problem)
    @MainActor private static let offlineImage = render(.offline)

    private static let canvas = NSSize(width: 18, height: 18)
    private static let badgeCenter = NSPoint(x: 15.6, y: 2.4)
    private static let badgeRadius: CGFloat = 2.2
    private static let badgeClearance: CGFloat = 3.3

    /// π outline from the OMP hero art: 178 × 170 units, bar 36 tall, legs 37 wide.
    private static func piPath() -> NSBezierPath {
        let scale: CGFloat = 15 / 178
        let origin = NSPoint(x: 1, y: (canvas.height - 170 * scale) / 2)
        let outline: [(CGFloat, CGFloat)] = [
            (0, 0), (178, 0), (178, 36), (135, 36), (135, 170), (98, 170),
            (98, 36), (62, 36), (62, 126), (25, 126), (25, 36), (0, 36),
        ]
        let path = NSBezierPath()
        for (index, (x, y)) in outline.enumerated() {
            let point = NSPoint(x: origin.x + x * scale, y: origin.y + y * scale)
            if index == 0 { path.move(to: point) } else { path.line(to: point) }
        }
        path.close()
        return path
    }

    private static func circle(radius: CGFloat) -> NSBezierPath {
        NSBezierPath(ovalIn: NSRect(
            x: badgeCenter.x - radius,
            y: badgeCenter.y - radius,
            width: radius * 2,
            height: radius * 2
        ))
    }

    private static func render(_ mark: MenuBarMark) -> NSImage {
        let image = NSImage(size: canvas, flipped: true) { _ in
            NSColor.black.setFill()
            NSColor.black.setStroke()
            let pi = piPath()
            switch mark {
            case .online:
                pi.fill()
            case .offline:
                // Clip to the glyph so a 2pt stroke leaves a 1pt inner outline.
                NSGraphicsContext.saveGraphicsState()
                pi.addClip()
                pi.lineWidth = 2
                pi.stroke()
                NSGraphicsContext.restoreGraphicsState()
            case .waiting, .problem:
                pi.fill()
                NSGraphicsContext.current?.compositingOperation = .clear
                circle(radius: badgeClearance).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                if mark == .waiting {
                    circle(radius: badgeRadius).fill()
                } else {
                    let ring = circle(radius: badgeRadius - 0.5)
                    ring.lineWidth = 1
                    ring.stroke()
                }
            }
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "OMP Mobile"
        return image
    }
}
