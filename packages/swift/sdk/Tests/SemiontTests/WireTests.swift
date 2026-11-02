import Foundation
import Testing

@testable import Semiont

@Test func wireRoundTripPreservesSpelling() throws {
  let bytes = Data(#"{"type":"TextQuoteSelector","exact":"🦊é","prefix":"","suffix":""}"#.utf8)
  let value = try JSONDecoder().decode(TextQuoteSelector.self, from: bytes)
  let back = try JSONEncoder().encode(value)
  #expect(
    try JSONDecoder().decode(JSONValue.self, from: bytes)
      == JSONDecoder().decode(JSONValue.self, from: back))
}

@Test func checkedIdentifiersUseTheirRules() throws {
  #expect(try ResourceId("resource-one").value == "resource-one")
  #expect(ResourceId.parse("a/b") == nil)
  #expect(throws: (any Error).self) { try ResourceId("a/b") }
}
