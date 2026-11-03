import Foundation
import Testing

@testable import Semiont

@Test func busLogRunsEverySharedCase() throws {
  let table = try Spec.read("bus/log-cases.json").object
  for value in try required(table, "cases").array {
    let row = try value.object
    let payload = try required(row, "payload")
    #expect(shownOnBus(payload) == (try required(row, "shown")), "\(row["why"] ?? .null)")
    if let channel = row["channel"] {
      let registry = try required(Spec.read("bus/registry.json").object, "channels").array.map {
        try $0.object
      }
      let declared = try #require(registry.first { $0["channel"] == channel })
      var value = payload
      if declared["shape"] == .string("envelope") {
        value = try required(payload.object, "response")
      }
      _ = try roundTripModel(required(declared, "schema").text, value)
    }

  }
  for value in [
    JSONValue.null, .number(1), .bool(true), .string("token"), .array([.object(["token": .null])]),
  ] {
    #expect(shownOnBus(shownOnBus(value)) == shownOnBus(value))
  }
}
@Test func retryRunsEverySharedRuleAndHeader() throws {
  let table = try Spec.read("retry/cases.json").object
  var covered: Set<String> = []
  for value in try required(table, "rules").array {
    let row = try value.object
    let name = try required(row, "rule").text
    let rule = try #require(RetryContext(rawValue: name))
    covered.insert(name)
    let status: Int? = if case .number(let n) = row["status"] { Int(n) } else { nil }
    let method = try row["method"].map { try $0.text }
    #expect(
      .bool(rule.retryable(status: status, method: method)) == (try required(row, "retries")),
      "\(row["why"] ?? .null)")
  }
  #expect(covered == Set(RetryContext.allCases.map(\.rawValue)))
  for value in try required(table, "retryAfter").array {
    let row = try value.object
    let header: String? = if case .string(let text) = row["header"] { text } else { nil }
    let actual = retryAfterMs(header).map { JSONValue.number(Double($0)) } ?? .null
    #expect(actual == (try required(row, "ms")), "\(row["why"] ?? .null)")
  }
}
@Test func uploadMembersFollowTheMultipartSchema() throws {
  let request = PutBinaryRequest(
    name: "name", file: Data(), format: "text/plain", storageUri: "file:///text")
  let members = Set(Mirror(reflecting: request).children.compactMap(\.label))
  let schema = try Spec.read("components/schemas/ResourceUpload.json").object
  #expect(members == Set(try required(schema, "properties").object.keys))
}
@Test func stateGraphFollowsTheProtocolDocument() throws {
  let document = try String(
    contentsOf: Spec.repository.appendingPathComponent("docs/protocol/TRANSPORT-HTTP.md"),
    encoding: .utf8)
  let rows = document.split(separator: "\n").filter { $0.contains("→") }
  var covered: Set<String> = []
  for row in rows {
    let sides = row.components(separatedBy: "→")
    guard sides.count == 2,
      let source = ConnectionState(rawValue: sides[0].trimmingCharacters(in: .whitespaces))
    else { continue }
    covered.insert(source.rawValue)
    let targets = Set(
      sides[1].split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) })
    for destination in ConnectionState.allCases {
      #expect(source.mayBecome(destination) == targets.contains(destination.rawValue))
    }
  }
  #expect(covered == Set(ConnectionState.allCases.map(\.rawValue)))
}
