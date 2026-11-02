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
    .appendingPathComponent("../../../../../specs/src").standardizedFileURL
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
