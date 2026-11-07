import Foundation
import SemiontTesting
import Testing

@testable import Semiont

func keptDescriptor(_ id: String) throws -> ResourceDescriptor {
  try decoded(
    ResourceDescriptor.self,
    .object([
      "@context": .string("https://schema.org/"), "@id": .string(id), "name": .string(id),
      "representations": .array([]),
    ]))
}

func keptAnnotation(_ id: String, of resource: String) throws -> Annotation {
  try decoded(
    Annotation.self,
    .object([
      "@context": .string("http://www.w3.org/ns/anno.jsonld"), "type": .string("Annotation"),
      "id": .string(id), "motivation": .string("highlighting"),
      "target": .object(["source": .string(resource)]),
      "created": .string("2026-01-01T00:00:00.000Z"),
    ]))
}

private func storedJSON(_ text: String?) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: Data(try #require(text).utf8))
}

/// Advance `clock` until the text stored under `key` is `written`.
private func saved(
  _ storage: MemorySessionStorage, _ key: String, on clock: TestClock,
  _ written: @escaping @Sendable (String) -> Bool
) async throws {
  try await withinTestDeadline {
    while true {
      if let text = storage.get(key), written(text) { return }
      clock.advance(by: .milliseconds(Timings.saveDebounceMs))
      await Task.yield()
    }
  }
}

@Test func aPlaceIsWrittenOnlyBesideAKeptDocumentWhileNothingIsUnsettled() async throws {
  let storage = MemorySessionStorage()
  let persistence = CachePersistence(storage: storage, keyPrefix: "kb")
  let placesKey = lastEventIdKeyPrefix + "kb"
  let documentKey = persistence.documentKey(CacheQuery.resource.rawValue)
  let resource = try ResourceId("res-1")
  let clock = TestClock()
  let keeping = Keeping(persistence, clock: clock)
  defer { keeping.close() }
  let book: StoragePersister<ResourceId, KeptResource> = try #require(
    keeping.persister(.resource))

  keeping.places.heard("e-res-1-6", in: resource)
  keeping.places.heard("p-res-1-7", in: resource)
  #expect(storage.get(placesKey) == nil, "A place heard is no reason to write")
  book.store(resource, try keptDescriptor("one"))
  try await saved(storage, documentKey, on: clock) { $0.contains(#""one""#) }
  #expect(Places.read(storage.get(placesKey)) == [resource: "p-res-1-7"])
  #expect(try storedJSON(storage.get(placesKey)) == .object(["res-1": .string("p-res-1-7")]))

  keeping.underway.begin()
  keeping.places.heard("p-res-1-8", in: resource)
  book.store(resource, try keptDescriptor("two"))
  try await saved(storage, documentKey, on: clock) { $0.contains(#""two""#) }
  #expect(
    Places.read(storage.get(placesKey)) == [resource: "p-res-1-7"],
    "A fetch under way holds the place back")
  keeping.underway.end()
}

@Test func disposalReadsThePlacesGateOnceBeforeAnythingIsDisposed() async throws {
  let storage = MemorySessionStorage()
  let persistence = CachePersistence(storage: storage, keyPrefix: "kb")
  let placesKey = lastEventIdKeyPrefix + "kb"
  let documentKey = persistence.documentKey(CacheQuery.resource.rawValue)
  let resource = try ResourceId("res-1")
  let clock = TestClock()

  let owing = Keeping(persistence, clock: clock)
  let book: StoragePersister<ResourceId, KeptResource> = try #require(owing.persister(.resource))
  let window = Cache<String, Int>(
    lifetime: Lifetime(), ownsLifetime: true, owed: owing.underway, invalidationWindowMs: 1000,
    clock: clock
  ) { _ in 1 }
  _ = try await window.fetch("a")
  await window.refresh("a", coalescing: true)
  await window.refresh("a", coalescing: true)
  owing.places.heard("p-res-1-7", in: resource)
  book.store(resource, try keptDescriptor("owing"))
  owing.close()
  window.dispose()
  #expect(storage.get(documentKey)?.contains(#""owing""#) == true, "The documents are flushed")
  #expect(storage.get(placesKey) == nil, "A refetch owed at disposal holds the places back")

  let quiet = Keeping(persistence, clock: clock)
  let quietBook: StoragePersister<ResourceId, KeptResource> = try #require(
    quiet.persister(.resource))
  quiet.places.heard("p-res-1-8", in: resource)
  quietBook.store(resource, try keptDescriptor("quiet"))
  quiet.close()
  #expect(storage.get(documentKey)?.contains(#""quiet""#) == true)
  #expect(
    Places.read(storage.get(placesKey)) == [resource: "p-res-1-8"],
    "A save owed at disposal is the flush, and holds nothing back")
}

@Test func disposalWritesOnlyThePlacesNotedBeforeItReadTheGate() throws {
  let storage = MemorySessionStorage()
  let persistence = CachePersistence(storage: storage, keyPrefix: "kb")
  let resource = try ResourceId("res-1")
  let other = try ResourceId("res-2")
  let keeping = Keeping(persistence, clock: TestClock())
  let book: StoragePersister<ResourceId, KeptResource> = try #require(
    keeping.persister(.resource))
  keeping.places.heard("p-res-1-8", in: resource)
  book.store(resource, try keptDescriptor("res-1"))
  keeping.places.close {
    keeping.places.heard("p-res-1-9", in: resource)
    keeping.places.heard("p-res-2-1", in: other)
    book.close()
  }
  keeping.close()
  #expect(Places.read(storage.get(lastEventIdKeyPrefix + "kb")) == [resource: "p-res-1-8"])
}

@Test func aRefetchAWindowOwesUnsettlesTheClientUntilItRuns() async throws {
  let clock = TestClock()
  let unsettled = Unsettled()
  let cache = Cache<String, Int>(
    lifetime: Lifetime(), ownsLifetime: true, owed: unsettled, invalidationWindowMs: 1000,
    clock: clock
  ) { _ in 1 }
  defer { cache.dispose() }
  _ = try await cache.fetch("a")
  await cache.refresh("a", coalescing: true)
  #expect(unsettled.settled, "The first invalidation runs at once")
  await cache.refresh("a", coalescing: true)
  #expect(!unsettled.settled, "One more inside the window is owed")
  try await withinTestDeadline {
    while !unsettled.settled {
      clock.advance(by: .milliseconds(1000))
      await Task.yield()
    }
  }
}

@Test func aValueReceivedAgainUnchangedKeepsTheTimeItWasFirstReceived() throws {
  let storage = MemorySessionStorage()
  let persistence = CachePersistence(storage: storage, keyPrefix: "kb")
  let key = persistence.documentKey("stamps")
  let first = StoragePersister<String, String>(persistence, name: "stamps")
  first.store("a", "one")
  first.close()
  let written = try storedJSON(storage.get(key))
  let again = StoragePersister<String, String>(persistence, name: "stamps")
  again.store("a", "one")
  again.close()
  #expect(try storedJSON(storage.get(key)) == written)
}

@Test func aDocumentTooLargeLosesTheEntriesReceivedLongestAgo() throws {
  let storage = MemorySessionStorage()
  let persistence = CachePersistence(storage: storage, keyPrefix: "kb")
  let key = persistence.documentKey("large")
  let large = String(repeating: "x", count: Timings.maxStoredBytesCount * 2 / 5)
  storage.set(
    key, #"{"version":1,"entries":[["old","\#(large)",1],["mid","\#(large)",2]]}"#)
  let persister = StoragePersister<String, String>(persistence, name: "large")
  #expect(Set(persister.keys) == ["old", "mid"])
  persister.store("new", large)
  persister.close()
  let text = try #require(storage.get(key))
  #expect(text.utf8.count <= Timings.maxStoredBytesCount)
  let entries = try required(storedJSON(text).object, "entries").array
  #expect(Set(try entries.map { try $0.array[0].text }) == ["mid", "new"])
}

@Test func aFailedFetchKeepsTheValueKeptAndAGoneKeyIsKeptNoLonger() async throws {
  let storage = MemorySessionStorage()
  let persistence = CachePersistence(storage: storage, keyPrefix: "kb")
  let cache = Cache<String, String>(persistence: persistence, name: "failing") { _ in
    throw BusRequestError(.busClosed, "The knowledge base is away")
  }
  await cache.set("kept", value: "a value")
  await cache.set("gone", value: "a value")
  #expect((try? await cache.fetch("kept")) == nil)
  await cache.remove("gone", gone: BusRequestError(.busNotFound, "gone"))
  cache.dispose()
  let entries = try required(
    storedJSON(storage.get(persistence.documentKey("failing"))).object, "entries"
  ).array
  #expect(try entries.map { try $0.array[0].text } == ["kept"])
  #expect(try entries.map { try $0.array[1].text } == ["a value"])
}
