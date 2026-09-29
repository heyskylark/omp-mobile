// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "OMPMobileBar",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "OMP Mobile", targets: ["OMPMobileBar"]),
    ],
    targets: [
        .executableTarget(
            name: "OMPMobileBar",
            path: "Sources/OMPMobileBar"
        ),
    ]
)
