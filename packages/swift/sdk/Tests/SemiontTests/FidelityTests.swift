import Foundation
import Testing

@testable import Semiont

private func json(_ text: String) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
}

@Test func nullableMembersPreserveAbsenceAndExplicitNull() throws {
  let model = GetAnnotationsResponse(annotations: [], total: 0)
  let absent = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(model))
  let back = try roundTripModel("GetAnnotationsResponse", absent)
  #expect(back == absent)
  for value in [JSONValue.null, .string("commenting")] {
    var payload = try absent.object
    payload["motivation"] = value
    #expect(try roundTripModel("GetAnnotationsResponse", .object(payload)) == .object(payload))
  }
}

@Test func requiredNullableMembersAreNeverManufactured() throws {
  let model = UserResponse(
    did: try UserId("did:web:kb.example:users:a"), domain: "kb.example", email: nil, image: nil,
    name: nil)
  let input = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(model))
  #expect(try roundTripModel("UserResponse", input) == input)
  for (key, value) in try input.object where value == .null {
    var missing = try input.object
    missing.removeValue(forKey: key)
    #expect(throws: DecodingError.self) { try roundTripModel("UserResponse", .object(missing)) }
  }
}

@Test func openJSONPreservesNestedValuesAndDateStrings() throws {
  let input = try json(
    #"{"a":null,"b":[1,true,{"timestamp":"2026-11-02T00:00:00.111Z"}],"label":"é🦊"}"#)
  let bytes = try JSONEncoder().encode(input)
  #expect(try JSONDecoder().decode(JSONValue.self, from: bytes) == input)
}

@Test func unknownEnumsAndDiscriminatorsAreRefused() throws {
  #expect(throws: (any Error).self) { try roundTripModel("JobType", .string("future-job")) }
  #expect(throws: (any Error).self) {
    try roundTripModel("Selector", json(#"{"type":"FutureSelector"}"#))
  }
}

@Test func generatedOpenObjectsKeepUnknownFieldsWithoutOverridingNamedOnes() throws {
  let input = try json(
    #"{"requiredValue":"x","requiredNullable":null,"future":{"items":[1,null,true]}}"#)
  let bytes = try JSONEncoder().encode(input)
  let fixture = try JSONDecoder().decode(FidelityFixture.self, from: bytes)
  #expect(try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(fixture)) == input)
  var conflicting = fixture
  conflicting.rest["requiredValue"] = .string("overridden")
  #expect(throws: EncodingError.self) { try JSONEncoder().encode(conflicting) }
}

@Test func generatedOptionalNonNullableMembersRefuseNull() throws {
  let input = Data(#"{"requiredValue":"x","requiredNullable":null,"optionalValue":null}"#.utf8)
  #expect(throws: DecodingError.self) {
    try JSONDecoder().decode(FidelityFixture.self, from: input)
  }
}

@Test func timestampsAndUnicodeAreNotNormalised() throws {
  let time = "2026-11-02T00:00:00.111Z"
  let model = SignIn(
    issuer: "https://issuer.example", obtainedAt: time, token: "token",
    tokenEndpoint: "https://issuer.example/token")
  let back = try JSONDecoder().decode(SignIn.self, from: JSONEncoder().encode(model))
  #expect(back.obtainedAt.utf8.elementsEqual(time.utf8))
  let exact = "e\u{301}🦊"
  let selector = TextQuoteSelector(exact: exact)
  let selectorBack = try JSONDecoder().decode(
    TextQuoteSelector.self, from: JSONEncoder().encode(selector))
  #expect(selectorBack.exact.utf8.elementsEqual(exact.utf8))
}

@Test func requiredDiscriminantsAreCheckedOnDecode() throws {
  #expect(throws: DecodingError.self) {
    try roundTripModel("TextQuoteSelector", json(#"{"exact":"text"}"#))
  }
  #expect(throws: DecodingError.self) {
    try roundTripModel("TextQuoteSelector", json(#"{"type":"FutureSelector","exact":"text"}"#))
  }
}
