import Foundation
import PackagePlugin

@main
struct GenerateSemiontPlugin: BuildToolPlugin {
  func createBuildCommands(context: PluginContext, target: any Target) throws -> [Command] {
    let specs = context.package.directoryURL.appendingPathComponent("../../../specs/src")
      .standardizedFileURL
    guard let files = FileManager.default.enumerator(at: specs, includingPropertiesForKeys: nil)
    else {
      throw PluginFailure.missingSpec
    }
    var inputs: [URL] = []
    for case let file as URL in files where file.pathExtension == "json" { inputs.append(file) }
    let mode: String
    switch target.name {
    case "Semiont": mode = "models"
    case "SemiontTests": mode = "tests"
    default: throw PluginFailure.unsupportedTarget
    }
    let output = context.pluginWorkDirectoryURL.appendingPathComponent("Models.swift")
    return [
      .buildCommand(
        displayName: "Generate Semiont models from specs/src",
        executable: try context.tool(named: "GenerateSemiont").url,
        arguments: [specs.path, output.path, mode],
        environment: [
          "LLVM_PROFILE_FILE": context.pluginWorkDirectoryURL.appendingPathComponent(
            "generator-%m-%p.profraw"
          ).path
        ],
        inputFiles: inputs.sorted { $0.path < $1.path }, outputFiles: [output]
      )
    ]
  }
}
enum PluginFailure: Error { case missingSpec, unsupportedTarget }
