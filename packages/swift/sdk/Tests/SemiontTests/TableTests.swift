import Foundation
import Testing

@testable import Semiont

private func asJSON<Value: Encodable>(_ value: Value) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(value))
}

@Test func generatedTableValuesKeepEveryRowAndField() throws {
  for (path, key, value) in [
    ("sdk-telemetry/telemetry.json", "spans", try asJSON(telemetrySpans)),
    ("sdk-telemetry/telemetry.json", "metrics", try asJSON(telemetryMetrics)),
    ("session/oauth.json", "clients", try asJSON(oauthClients)),
    ("session/oauth.json", "scope", try asJSON(signInScope)),
    ("sign-in-store/owner-only.json", "directoryMode", try asJSON(ownerOnlyDirectory)),
    ("sign-in-store/owner-only.json", "fileMode", try asJSON(ownerOnlyFile)),
    ("media-types/registry.json", "mediaTypes", try asJSON(mediaTypes)),
    ("media-types/registry.json", "extensionAliases", try asJSON(extensionAliases)),
    ("client/refresh.json", "queries", try asJSON(cacheQueries)),
    ("bus/registry.json", "audience", try asJSON(busAudience)),
  ] {
    #expect(try required(Spec.read(path).object, key) == value, "\(path) \(key)")
  }
  #expect(
    try required(required(Spec.read("bus/registry.json").object, "trace").object, "field").text
      == traceField)
}

@Test func generatedRefreshTableKeepsEveryRowAndWay() throws {
  let stated = try required(Spec.read("client/refresh.json").object, "refresh").array.map {
    try $0.object
  }
  let channels = Set(
    try required(Spec.read("bus/registry.json").object, "channels").array.map {
      try required($0.object, "channel").text
    })
  func way(_ value: JSONValue?) throws -> [String]? {
    try value.map { try $0.text.split(separator: ".").map(String.init) }
  }
  func queries(_ value: JSONValue?) throws -> [String] {
    try value?.array.map { try $0.text } ?? []
  }
  #expect(stated.count == cacheRefresh.count)
  for (row, generated) in zip(stated, cacheRefresh) {
    let names = try row["names"]?.object
    #expect(try required(row, "on").text == generated.on.rawValue)
    #expect(try row["when"]?.text == generated.when?.rawValue)
    #expect(try (row["reach"]?.text ?? "subject") == generated.reach.rawValue)
    #expect(try way(names?["resource"]) == generated.resource)
    #expect(try way(names?["annotation"]) == generated.annotation)
    #expect(try way(row["carries"]) == generated.carries)
    #expect(try queries(row["refetches"]) == generated.refetches.map(\.rawValue))
    #expect(try queries(row["writes"]) == generated.writes.map(\.rawValue))
    #expect(try queries(row["removes"]) == generated.removes.map(\.rawValue))
  }
  let triggers = Set(try stated.map { try required($0, "on").text })
  #expect(Set(cacheRefreshChannels.keys.map(\.rawValue)) == triggers.intersection(channels))
}

@Test func transportErrorClassifierUsesTheSpec() throws {
  let family = try required(Spec.read("errors/codes.json").object, "transport").object
  let codes = try required(family, "codes").array.map { try $0.object }
  let fallback = try required(family, "unclassified").text
  for status in 100...599 {
    var expected = fallback
    if let exact = codes.first(where: { $0["status"] == .number(Double(status)) }) {
      expected = try required(exact, "code").text
    } else if let range = codes.first(where: {
      if case .number(let lower) = $0["statusFrom"] { return Double(status) >= lower }
      return false
    }) {
      expected = try required(range, "code").text
    }
    #expect(transportErrorCode(for: status).rawValue == expected)
  }
}
