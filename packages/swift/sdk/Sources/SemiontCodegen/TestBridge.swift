import Foundation

/// Test-only dispatch is derived from the schema census, never shipped in Semiont.
package func testBridge(definitions: [String: JSONValue], identifiers: Set<String>) throws -> String
{
  var out = """
    // Generated from protocol/specs/src; do not edit.
    import Foundation
    import Testing
    @testable import Semiont
    private func roundTrip<Value: Codable>(_ type: Value.Type, _ input: JSONValue) throws -> JSONValue {
      let data = try JSONEncoder().encode(input)
      let value = try JSONDecoder().decode(type, from: data)
      return try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
    }
    func roundTripModel(_ name: String, _ value: JSONValue) throws -> JSONValue {
      switch name {
    """ + "\n"
  for name in definitions.keys.sorted() {
    out += "  case \(literal(name)): return try roundTrip(\(name).self, value)\n"
  }
  out += "  default: throw BridgeFailure.unknownSchema(name)\n  }\n}\n"
  out += "enum BridgeFailure: Error { case unknownSchema(String) }\n"
  out +=
    "let identifierKinds: [String: (@Sendable (String) throws -> String, @Sendable (String) -> String?)] = [\n"
  for name in identifiers.sorted() {
    out += "  \(literal(name)): ({ try \(name)($0).value }, { \(name).parse($0)?.value }),\n"
  }
  out += "]\n"
  let fixture =
    #"{"type":"object","properties":{"requiredValue":{"type":"string"},"requiredNullable":{"type":"string","nullable":true},"optionalValue":{"type":"string"},"optionalNullable":{"type":"string","nullable":true}},"required":["requiredValue","requiredNullable"],"additionalProperties":true}"#
  return out + (try generateModels(["FidelityFixture": fixture]))

}
