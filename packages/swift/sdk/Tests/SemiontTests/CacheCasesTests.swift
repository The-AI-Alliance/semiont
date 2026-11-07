import Foundation
import SemiontTesting
import Testing

@testable import Semiont

/// The shared cases of what a client keeps, each run through a client's own persisters over a
/// storage in memory, under the keys session/stored.json gives.
private func sharedCases(_ member: String) throws -> [[String: JSONValue]] {
  let cases = try required(Spec.read("session/cache-cases.json").object, member).array.map {
    try $0.object
  }
  #expect(!cases.isEmpty, "session/cache-cases.json holds \(member)")
  return cases
}

private let keyPrefix = "kb"

private struct StoredKeys {
  let documents: String
  let places: String
  let whole: String

  init() throws {
    let stored = try Spec.read("session/stored.json").object
    documents = try required(required(stored, "cacheKeyPrefix").object, "prefix").text + keyPrefix
    places =
      try required(required(stored, "lastEventIdKeyPrefix").object, "prefix").text + keyPrefix
    whole = try required(required(stored, "wholeKey").object, "key").text
  }

  func document(_ query: CacheQuery) -> String { "\(documents).\(query.rawValue)" }
}

private func caseName(_ row: [String: JSONValue]) throws -> String {
  try required(row, "name").text
}

private func caseQuery(_ row: [String: JSONValue]) throws -> CacheQuery {
  let name = try required(row, "query").text
  guard let query = CacheQuery(rawValue: name) else {
    throw SpecFailure.shape("\(name) is no query of client/refresh.json")
  }
  return query
}

/// A case's text: `storedText` as it is, or `stored` as JSON.
private func caseText(_ row: [String: JSONValue]) throws -> String {
  if let text = row["storedText"] { return try text.text }
  return String(decoding: try JSONEncoder().encode(required(row, "stored")), as: UTF8.self)
}

/// Entries as a map from each key, as a document writes it, to its value.
private func entryMap(_ entries: JSONValue) throws -> [String: JSONValue] {
  var map: [String: JSONValue] = [:]
  for entry in try entries.array {
    let parts = try entry.array
    guard parts.count >= 2 else { throw SpecFailure.shape("an entry with no key and value") }
    map[try parts[0].text] = parts[1]
  }
  return map
}

private func keepingClient(over storage: MemorySessionStorage) async throws -> SemiontClient {
  try await SemiontClient(
    transport: ProbeTransport(),
    persistence: CachePersistence(storage: storage, keyPrefix: keyPrefix))
}

/// What a new client over `storage` holds of `query`: each key as its document writes it, and
/// the value.
private func loaded(
  _ query: CacheQuery, from storage: MemorySessionStorage, keys: StoredKeys, _ name: String
) async throws -> [String: JSONValue] {
  let client = try await keepingClient(over: storage)
  defer { client.dispose() }
  let live = client.browse.live
  var held: [String: JSONValue] = [:]
  switch query {
  case .resource:
    for key in await live.resources.keys() {
      held[key.value] = try encoded(try #require(await live.resources.get(key)))
    }
  case .annotations:
    for key in await live.annotations.keys() {
      held[key.value] = try encoded(try #require(await live.annotations.get(key)))
    }
  case .annotation:
    for key in await live.details.keys() {
      let annotation = try #require(await live.details.get(key))
      #expect(
        key.resource == targetSource(annotation.target),
        "\(name): a kept annotation is of the resource its target is")
      held[key.annotation.value] = try encoded(annotation)
    }
  case .entityTypes:
    if let value = await live.entityTypes.snapshot() { held[keys.whole] = try encoded(value) }
  case .tagSchemas:
    if let value = await live.tagSchemas.snapshot() { held[keys.whole] = try encoded(value) }
  case .events, .referencedBy, .resources, .matchedResources, .engines:
    throw SpecFailure.shape("\(query) is not kept")
  }
  return held
}

/// Hold `value` as `key`'s in `query`'s cache, as its answer would.
private func hold(
  _ query: CacheQuery, _ key: JSONValue, _ value: JSONValue, in live: LiveQueries,
  keys: StoredKeys
) async throws {
  switch query {
  case .resource:
    await live.resources.set(
      try decoded(ResourceId.self, key), value: try decoded(KeptResource.self, value))
  case .annotations:
    await live.annotations.set(
      try decoded(ResourceId.self, key), value: try decoded(KeptAnnotations.self, value))
  case .annotation:
    let annotation = try decoded(KeptAnnotation.self, value)
    await live.details.set(
      LiveQueries.AnnotationKey(
        resource: targetSource(annotation.target), annotation: try decoded(AnnotationId.self, key)),
      value: annotation)
  case .entityTypes:
    #expect(try key.text == keys.whole)
    await live.entityTypes.replace(.ready(try decoded(KeptEntityTypes.self, value)))
  case .tagSchemas:
    #expect(try key.text == keys.whole)
    await live.tagSchemas.replace(.ready(try decoded(KeptTagSchemas.self, value)))
  case .events, .referencedBy, .resources, .matchedResources, .engines:
    throw SpecFailure.shape("\(query) is not kept")
  }
}

@Test func aLoadKeepsWhatEverySharedCaseKeeps() async throws {
  let keys = try StoredKeys()
  for row in try sharedCases("cases") {
    let name = try caseName(row)
    let query = try caseQuery(row)
    let storage = MemorySessionStorage()
    storage.set(keys.document(query), try caseText(row))
    let held = try await loaded(query, from: storage, keys: keys, name)
    #expect(held == (try entryMap(required(row, "kept"))), "\(name)")
  }
}

@Test func aSaveWritesWhatEverySharedCaseWrites() async throws {
  let keys = try StoredKeys()
  for row in try sharedCases("writes") {
    let name = try caseName(row)
    let query = try caseQuery(row)
    let storage = MemorySessionStorage()
    let client = try await keepingClient(over: storage)
    for pair in try required(row, "held").array {
      let parts = try pair.array
      guard parts.count == 2 else { throw SpecFailure.shape("\(name): a held key and value") }
      try await hold(query, parts[0], parts[1], in: client.browse.live, keys: keys)
    }
    client.dispose()
    let text = try #require(storage.get(keys.document(query)), "\(name): a document is written")
    let document = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)).object
    let written = try required(row, "written").object
    #expect(Set(document.keys) == Set(written.keys), "\(name)")
    #expect(try required(document, "version") == required(written, "version"), "\(name)")
    let entries = try required(document, "entries")
    #expect(try entryMap(entries) == entryMap(required(written, "entries")), "\(name)")
    for entry in try entries.array {
      let parts = try entry.array
      guard parts.count == 3, case .number(let stamp) = parts[2] else {
        Issue.record("\(name): an entry is a key, a value and a stamp")
        continue
      }
      #expect(
        stamp >= 0 && stamp.rounded() == stamp, "\(name): a stamp is a whole number of at least 0")
    }
  }
}

@Test func aLoadOfPlacesKeepsWhatEverySharedCaseKeeps() throws {
  let keys = try StoredKeys()
  for row in try sharedCases("places") {
    let name = try caseName(row)
    let storage = MemorySessionStorage()
    storage.set(keys.places, try caseText(row))
    let places = Keeping(
      CachePersistence(storage: storage, keyPrefix: keyPrefix), clock: ContinuousClock()
    ).places.kept
    let kept = try required(row, "kept").object.mapValues { try $0.text }
    #expect(
      Dictionary(uniqueKeysWithValues: places.map { ($0.key.value, $0.value) }) == kept, "\(name)")
  }
}
