// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "Semiont",
  platforms: [.macOS(.v15), .iOS(.v18)],
  products: [.library(name: "Semiont", targets: ["Semiont"])],
  dependencies: [
    .package(url: "https://github.com/apple/swift-crypto.git", from: "5.0.3"),
    .package(url: "https://github.com/apple/swift-nio.git", from: "2.104.0"),
    .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.36.2"),
    .package(url: "https://github.com/open-telemetry/opentelemetry-swift-core.git", from: "2.6.0"),
    .package(url: "https://github.com/open-telemetry/opentelemetry-swift.git", from: "2.6.0"),
  ],
  targets: [
    .executableTarget(
      name: "SemiontWireDriver",
      dependencies: [
        "Semiont",
        .product(name: "AsyncHTTPClient", package: "async-http-client"),
        .product(name: "OpenTelemetrySdk", package: "opentelemetry-swift-core"),
        .product(name: "OpenTelemetryProtocolExporterHTTP", package: "opentelemetry-swift"),
      ], path: "Conformance", exclude: ["launch.sh"], swiftSettings: [.treatAllWarnings(as: .error)]
    ),
    .target(
      name: "Semiont",
      dependencies: [
        .product(name: "Crypto", package: "swift-crypto"),
        .product(name: "CryptoExtras", package: "swift-crypto"),
        .product(name: "NIOCore", package: "swift-nio"),
        .product(name: "AsyncHTTPClient", package: "async-http-client"),
        .product(name: "OpenTelemetryApi", package: "opentelemetry-swift-core"),
      ], swiftSettings: [.treatAllWarnings(as: .error)],
      plugins: ["GenerateSemiontPlugin"]),
    .executableTarget(
      name: "GenerateSemiont", dependencies: ["SemiontCodegen"],
      swiftSettings: [.treatAllWarnings(as: .error)]),
    .plugin(
      name: "GenerateSemiontPlugin", capability: .buildTool(), dependencies: ["GenerateSemiont"]),
    .target(name: "SemiontCodegen", swiftSettings: [.treatAllWarnings(as: .error)]),
    .testTarget(
      name: "SemiontTests",
      dependencies: [
        .product(name: "CryptoExtras", package: "swift-crypto"),
        "Semiont",
        .product(name: "AsyncHTTPClient", package: "async-http-client"),
        .product(name: "NIOPosix", package: "swift-nio"),
        .product(name: "NIOHTTP1", package: "swift-nio"),
        .product(name: "OpenTelemetrySdk", package: "opentelemetry-swift-core"),
      ],
      swiftSettings: [.treatAllWarnings(as: .error)], plugins: ["GenerateSemiontPlugin"]),
    .testTarget(
      name: "SemiontCodegenTests", dependencies: ["SemiontCodegen"],
      swiftSettings: [.treatAllWarnings(as: .error)]),
  ],
  swiftLanguageModes: [.v6]
)
