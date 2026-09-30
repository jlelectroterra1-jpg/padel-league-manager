// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "PadelScorerKit",
    platforms: [
        .iOS(.v16),
        .watchOS(.v9)
    ],
    products: [
        .library(name: "PadelScorerKit", targets: ["PadelScorerKit"])
    ],
    targets: [
        .target(name: "PadelScorerKit"),
        .testTarget(name: "PadelScorerKitTests", dependencies: ["PadelScorerKit"])
    ]
)
