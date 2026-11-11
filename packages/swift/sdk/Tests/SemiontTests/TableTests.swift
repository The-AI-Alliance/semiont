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

/// What a live query's cache holds, as client/refresh.json's `value` names it: a component, and
/// the members within it that the value is, outermost first.
private struct HeldValue: Equatable, CustomStringConvertible {
  let component: String
  let members: [String]

  var description: String { ([component] + members).joined(separator: ".") }
}

/// What `value`'s reference names: the component of its file, and each member its pointer
/// passes, `#/properties/a/properties/b` passing a, then b.
private func heldValue(_ value: JSONValue) throws -> HeldValue {
  let reference = try required(value.object, "$ref").text
  let parts = reference.split(separator: "#", omittingEmptySubsequences: false).map(String.init)
  guard parts.count <= 2 else { throw SpecFailure.shape("\(reference) is no reference") }
  let component = URL(fileURLWithPath: parts[0]).deletingPathExtension().lastPathComponent
  guard parts.count == 2 else { return HeldValue(component: component, members: []) }
  let way = parts[1].split(separator: "/", omittingEmptySubsequences: false).map(String.init)
  guard way.first == "", way.count % 2 == 1 else {
    throw SpecFailure.shape("\(reference) is no way through members")
  }
  var members: [String] = []
  for index in stride(from: 1, to: way.count, by: 2) {
    guard way[index] == "properties" else {
      throw SpecFailure.shape("\(reference) passes \(way[index]), which is no member")
    }
    members.append(way[index + 1])
  }
  return HeldValue(component: component, members: members)
}

/// The component `component`, held by the cache at `cache`: the compiler holds the cache to it.
private func held<Key, Value>(
  _ cache: KeyPath<LiveQueries, Cache<Key, Value>>, _ component: Value.Type
) -> HeldValue {
  HeldValue(component: String(describing: component), members: [])
}

/// The member of the component `Root` that `member` reads, named member by member, outermost
/// first, held by the cache at `cache`: the compiler holds the cache to the member's type.
private func held<Key, Root, Value>(
  _ cache: KeyPath<LiveQueries, Cache<Key, Value>>, _ member: KeyPath<Root, Value>,
  _ names: String...
) -> HeldValue {
  HeldValue(component: String(describing: Root.self), members: names)
}

/// The member of the component `Root` that `member` reads, named member by member, outermost
/// first, held by the query at `query`: the compiler holds the query to the member's type.
private func held<Root, Value>(
  _ query: KeyPath<LiveQueries, Cached<Value>>, _ member: KeyPath<Root, Value>,
  _ names: String...
) -> HeldValue {
  HeldValue(component: String(describing: Root.self), members: names)
}

@Test func everyLiveQueryHoldsTheValueTheRefreshTableNames() throws {
  // Each live query, by its name in client/refresh.json, and what its cache holds.
  let census: [String: HeldValue] = [
    "resource": held(\LiveQueries.resources, ResourceDescriptor.self),
    "annotations": held(\LiveQueries.annotations, GetAnnotationsResponse.self),
    "annotation": held(\LiveQueries.details, Annotation.self),
    "events": held(\LiveQueries.events, \GetEventsResponse.events, "events"),
    "referencedBy": held(
      \LiveQueries.referencedBy, \GetReferencedByResponse.referencedBy, "referencedBy"),
    "resources": held(\LiveQueries.listedResources, ListResourcesResponse.self),
    "matchedResources": held(\LiveQueries.matchedResources, MatchResourcesResponse.self),
    "entityTypes": held(
      \LiveQueries.entityTypes, \GetEntityTypesResponse.entityTypes, "entityTypes"),
    "tagSchemas": held(\LiveQueries.tagSchemas, \GetTagSchemasResponse.tagSchemas, "tagSchemas"),
    "engines": held(
      \LiveQueries.engines, \BrowseEnginesResult.response.engines, "response", "engines"),
  ]
  var stated: [String: HeldValue] = [:]
  for raw in try required(Spec.read("client/refresh.json").object, "queries").array {
    let row = try raw.object
    stated[try required(row, "name").text] = try heldValue(required(row, "value"))
  }
  #expect(Set(census.keys) == Set(stated.keys), "Every live query's value is held here")
  for (name, value) in census {
    #expect(stated[name] == value, "\(name)'s cache holds \(value)")
  }
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
