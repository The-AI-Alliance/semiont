import Foundation
import Testing

@testable import Semiont

func jwt(_ claims: JSONValue) throws -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys]
  return "e30." + base64URL(try encoder.encode(claims)) + ".c2ln"
}
@Test func tokensRunEverySharedCase() throws {
  let table = try Spec.read("session/cases.json").object
  for value in try required(table, "tokenExpiry").array {
    let row = try value.object
    let actual = tokenExpiry(try required(row, "token").text).map(JSONValue.number) ?? .null
    #expect(actual == (try required(row, "exp")))
  }
  for value in try required(table, "refreshSchedule").array {
    let row = try value.object
    let token = try row["token"].map { try $0.text } ?? jwt(required(row, "claims"))
    let now = try number(required(row, "now"))
    let actual = refreshDelay(token, now: now).map(JSONValue.number) ?? .null
    #expect(actual == (try required(row, "delay")))
  }
}
func number(_ value: JSONValue) throws -> Double {
  guard case .number(let number) = value else { throw SpecFailure.shape("Expected number") }
  return number
}
@Test func gatewayOriginsRunEverySharedCase() throws {
  for value in try required(Spec.read("session/gateway-url-cases.json").object, "cases").array {
    let row = try value.object
    let endpoint = try JSONDecoder().decode(
      HttpEndpoint.self, from: JSONEncoder().encode(required(row, "endpoint")))
    let actual = (try? gatewayUrl(endpoint)).map(JSONValue.string) ?? .null
    #expect(actual == (try required(row, "origin")))
  }
}
@Test func identityRunsEverySharedCase() throws {
  for value in try required(Spec.read("kb-identity/cases.json").object, "cases").array {
    let row = try value.object
    guard case .string(let domain) = row["domain"] else { continue }
    #expect(try kbDid(domain).value == required(row, "did").text)
    #expect(try kbResource(domain) == required(row, "resource").text)
  }
  let principals = try Spec.read("principals/cases.json").object
  for (key, make) in [("people", personDid), ("agents", agentDid)] {
    for value in try required(principals, key).array {
      let row = try value.object
      #expect(
        try make(required(row, "domain").text, required(row, "subject").text).value
          == required(row, "did").text)
    }
  }
}
