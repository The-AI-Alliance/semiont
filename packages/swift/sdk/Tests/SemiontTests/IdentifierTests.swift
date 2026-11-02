import Foundation
import Testing

@testable import Semiont

@Test func identifiersRunEveryKindCase() throws {
  let kinds = try required(Spec.read("identifiers/kinds.json").object, "kinds").array
  let names = try Set(kinds.map { try required($0.object, "schema").text })
  #expect(names == Set(identifierKinds.keys))
  for kind in kinds {
    let row = try kind.object
    let name = try required(row, "schema").text
    let (make, parse) = try #require(identifierKinds[name])
    for outcome in ["accepts", "refuses"] {
      for raw in try required(row, outcome).array {
        let text = try required(raw.object, "id").text
        if outcome == "accepts" {
          #expect(try make(text) == text)
          #expect(parse(text) == text)
          #expect(try roundTripModel(name, .string(text)) == .string(text))
        } else {
          #expect(throws: InvalidIdentifier.self) { try make(text) }
          #expect(parse(text) == nil)
          #expect(throws: DecodingError.self) { try roundTripModel(name, .string(text)) }
        }
      }
    }
  }
}

@Test func identifierWhitespaceUsesECMAScriptRules() throws {
  for scalar in ["\u{feff}", "\u{2028}", "\u{2029}", "\u{2000}"] {
    #expect(UserId.parse("did:web:a" + scalar) == nil)
  }
  #expect(try UserId("did:web:a\u{85}").value == "did:web:a\u{85}")
}

@Test func identifierPrefixAndLengthCountUnicodeScalars() throws {
  for suffix in ["\u{301}", "\u{200d}", "\u{fe0f}", "🦊"] {
    #expect(
      try UserId("did:" + suffix).value.unicodeScalars.elementsEqual(
        ("did:" + suffix).unicodeScalars))
  }
}

@Test func identifierEqualityKeepsTheIdentitySpelling() throws {
  let composed = try UserId("did:é")
  let decomposed = try UserId("did:e\u{301}")
  #expect(composed != decomposed)
  #expect(Set([composed, decomposed]).count == 2)
}
