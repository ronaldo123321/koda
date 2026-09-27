// swift-tools-version: 5.10

import PackageDescription

let package = Package(
    name: "KodaGUI",
    platforms: [.macOS(.v14)],
    products: [.executable(name: "KodaGUI", targets: ["KodaGUI"])],
    targets: [.executableTarget(name: "KodaGUI")]
)
