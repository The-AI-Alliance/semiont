import Foundation
import SemiontCodegen

@main
struct GenerateSemiont {
  static func main() {
    do { try run() } catch {
      FileHandle.standardError.write(Data("generation refused: \(error)\n".utf8))
      exit(1)
    }
  }
  static func run() throws {
    let args = CommandLine.arguments
    guard args.count == 4 else {
      throw GenerationRefused(description: "usage: <specs/src> <output.swift> <models|tests>")
    }
    let specs = URL(fileURLWithPath: args[1])
    let definitions = try loadDefinitions(specs)
    let kinds = try loadJSON(specs.appendingPathComponent("identifiers/kinds.json")).object
    guard let rows = kinds["kinds"] else {
      throw GenerationRefused(description: "identifiers/kinds.json has no kinds")
    }
    let identifiers = try Set(
      rows.array.map { row in
        guard let name = try row.object["schema"] else {
          throw GenerationRefused(description: "identifier kind without schema")
        }
        return try name.text
      })
    if args[3] == "tests" {
      try testBridge(definitions: definitions, identifiers: identifiers).write(
        toFile: args[2], atomically: true, encoding: .utf8)
      return
    }
    guard args[3] == "models" else {
      throw GenerationRefused(description: "unknown generation mode")
    }
    let generator = ModelGenerator(definitions: definitions, identifiers: identifiers)
    let tables = try TableGenerator(specs: specs, models: generator).generate()
    let output = try generator.generate() + "\n" + tables
    try output.write(toFile: args[2], atomically: true, encoding: .utf8)
  }
}
