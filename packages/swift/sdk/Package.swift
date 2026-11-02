// swift-tools-version: 6.2
import PackageDescription

let package = Package(
  name: "Semiont",
  products: [.library(name: "Semiont", targets: ["Semiont"])],
  targets: [
    .target(name: "Semiont", swiftSettings: [.treatAllWarnings(as: .error)])
  ],
  swiftLanguageModes: [.v6]
)
