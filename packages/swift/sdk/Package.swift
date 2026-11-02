// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "Semiont",
  products: [.library(name: "Semiont", targets: ["Semiont"])],
  targets: [
    .target(
      name: "Semiont", swiftSettings: [.treatAllWarnings(as: .error)],
      plugins: ["GenerateSemiontPlugin"]),
    .executableTarget(
      name: "GenerateSemiont", dependencies: ["SemiontCodegen"],
      swiftSettings: [.treatAllWarnings(as: .error)]),
    .plugin(
      name: "GenerateSemiontPlugin", capability: .buildTool(), dependencies: ["GenerateSemiont"]),
    .target(name: "SemiontCodegen", swiftSettings: [.treatAllWarnings(as: .error)]),
    .testTarget(
      name: "SemiontTests", dependencies: ["Semiont"],
      swiftSettings: [.treatAllWarnings(as: .error)], plugins: ["GenerateSemiontPlugin"]),
    .testTarget(
      name: "SemiontCodegenTests", dependencies: ["SemiontCodegen"],
      swiftSettings: [.treatAllWarnings(as: .error)]),
  ],
  swiftLanguageModes: [.v6]
)
