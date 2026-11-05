import Foundation
import Testing

@testable import SemiontCodegen

@Test func unknownSchemaShapeRefusesGeneration() throws {
  #expect(throws: GenerationRefused.self) {
    try generateModels(["Unsupported": #"{"type":["string","integer"]}"#])
  }
}

@Test func unsupportedSchemaVocabularyFailsLoudly() throws {
  for schema in [
    #"{"type":"object","not":{}}"#,
    #"{"type":"string","const":"x"}"#,
    #"{"type":"array"}"#,
    #"{"oneOf":[]}"#,
    #"{"type":"object","properties":{"x":{"type":"string","format":"secret-format"}}}"#,
    #"{"type":"object","properties":{"a-b":{"type":"string"},"aB":{"type":"string"}}}"#,
  ] {
    #expect(throws: GenerationRefused.self) { try generateModels(["Fixture": schema]) }
  }
}

@Test func unsupportedIdentifierPatternIsRefused() throws {
  let definitions = [
    "FixtureId": JSONValue.object(["type": .string("string"), "pattern": .string("^(a|b)+$")])
  ]
  #expect(throws: GenerationRefused.self) {
    try ModelGenerator(definitions: definitions, identifiers: ["FixtureId"]).generate()
  }
}

@Test func everySpecSchemaAndTableGeneratesTogether() throws {
  let specs = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../../../../protocol/specs/src").standardizedFileURL
  let definitions = try loadDefinitions(specs)
  let kinds = try #require(
    loadJSON(specs.appendingPathComponent("identifiers/kinds.json")).object["kinds"])
  let names = try Set(kinds.array.map { try #require($0.object["schema"]).text })
  let generator = ModelGenerator(definitions: definitions, identifiers: names)
  let tables = try TableGenerator(specs: specs, models: generator).generate()
  let models = try generator.generate()
  #expect(!tables.isEmpty)
  #expect(!models.isEmpty)
  #expect(Set(definitions.keys).isSubset(of: Set(generator.written.keys)))
}

@Test(arguments: ["no-schema", "ambiguous-message", "optional-message", "non-string-message"])
func operationFailureSchemaDriftRefusesGeneration(change: String) throws {
  let specs = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../../../../protocol/specs/src").standardizedFileURL
  var definitions = try loadDefinitions(specs)
  var registry = try loadJSON(specs.appendingPathComponent("bus/registry.json")).object
  if change == "no-schema" {
    registry["channels"] = .array(
      try #require(registry["channels"]).array.map { raw in
        var row = try raw.object
        if row["schema"] == .string("CommandError") { row["shape"] = .string("empty") }
        return .object(row)
      })
  } else {
    var failure = try #require(definitions["CommandError"]).object
    var properties = try #require(failure["properties"]).object
    switch change {
    case "ambiguous-message": properties["error"] = .object(["type": .string("string")])
    case "optional-message": failure["required"] = .array([])
    case "non-string-message": properties["message"] = .object(["type": .string("integer")])
    default:
      Issue.record("Unknown drift")
      return
    }
    failure["properties"] = .object(properties)
    definitions["CommandError"] = .object(failure)
  }
  let generator = TableGenerator(
    specs: specs, models: ModelGenerator(definitions: definitions, identifiers: []))
  let expected =
    switch change {
    case "no-schema": "failure channel has no schema"
    case "ambiguous-message": "failure needs one message field"
    default: "failure message must be a required string"
    }
  do {
    _ = try generator.channels(registry)
    Issue.record("Failure schema drift was accepted")
  } catch let error as GenerationRefused {
    #expect(error.description == expected)
  }
}
