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

private func joKey() throws -> String {
  personKey(try UserId("did:web:kb.example.org:users:jo%40example.org"))
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

@Test func aStreamPlaceIsWrittenOnlyWithTheCachesAndOnlyWhileTheyAreSettled() throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let persistence = CachePersistence(
    storage: storage, kbId: "kb-a", person: nil, writer: WritesAsGiven())
  let resource = try ResourceId("res-1")

  let unattached = KeptQueries(persistence, clock: ContinuousClock())
  unattached.heard("p-res-1-0", in: resource)
  unattached.store(.resource, resource, try keptDescriptor("before"))
  unattached.close()
  #expect(storage.get(cacheKey("kb-a", jo, .resource)) == nil)
  #expect(storage.get(lastEventIdKey("kb-a", jo)) == nil)

  let first = KeptQueries(persistence, clock: ContinuousClock())
  #expect(first.attach(jo) == [:])
  #expect(first.attach(jo) == nil)
  first.heard("e-ignored", in: resource)
  first.heard("p-res-1-1", in: resource)
  first.store(.resource, resource, try keptDescriptor("one"))
  first.close()

  let busy = KeptQueries(persistence, clock: ContinuousClock())
  #expect(busy.attach(jo) == [resource: "p-res-1-1"])
  #expect(busy.load(.resource, resource, as: KeptResource.self)?.name == "one")
  busy.underway.begin()
  busy.heard("p-res-1-2", in: resource)
  busy.store(.resource, resource, try keptDescriptor("two"))
  busy.close()
  busy.underway.end()

  let restored = KeptQueries(persistence, clock: ContinuousClock())
  #expect(restored.attach(jo) == [resource: "p-res-1-1"])
  #expect(restored.keys(.resource, as: ResourceId.self) == [resource])
  #expect(restored.load(.resource, resource, as: KeptResource.self)?.name == "two")
  restored.close()
}

@Test func aPlaceIsWrittenOnlyBesideAKeptDocumentWhileNothingIsUnsettled() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let placesKey = lastEventIdKey("kb", jo)
  let documentKey = cacheKey("kb", jo, .resource)
  let resource = try ResourceId("res-1")
  let clock = TestClock()
  let keeping = KeptQueries(
    CachePersistence(storage: storage, kbId: "kb", personKey: jo), clock: clock)
  defer { keeping.close() }
  #expect(keeping.attach(jo) == [:])

  keeping.heard("e-res-1-6", in: resource)
  keeping.heard("p-res-1-7", in: resource)
  #expect(storage.get(placesKey) == nil, "A place heard is no reason to write")
  keeping.store(.resource, resource, try keptDescriptor("one"))
  try await saved(storage, documentKey, on: clock) { $0.contains(#""one""#) }
  #expect(storedPlaces(storage.get(placesKey)) == [resource: "p-res-1-7"])
  #expect(try storedJSON(storage.get(placesKey)) == .object(["res-1": .string("p-res-1-7")]))

  keeping.underway.begin()
  keeping.heard("p-res-1-8", in: resource)
  keeping.store(.resource, resource, try keptDescriptor("two"))
  try await saved(storage, documentKey, on: clock) { $0.contains(#""two""#) }
  #expect(
    storedPlaces(storage.get(placesKey)) == [resource: "p-res-1-7"],
    "A fetch under way holds the place back")
  keeping.underway.end()
}

@Test func disposalReadsThePlacesGateOnceBeforeAnythingIsDisposed() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let persistence = CachePersistence(storage: storage, kbId: "kb", personKey: jo)
  let placesKey = lastEventIdKey("kb", jo)
  let documentKey = cacheKey("kb", jo, .resource)
  let resource = try ResourceId("res-1")
  let clock = TestClock()

  let owing = KeptQueries(persistence, clock: clock)
  #expect(owing.attach(jo) == [:])
  let window = Cache<String, Int>(
    lifetime: Lifetime(), ownsLifetime: true, owed: owing.underway, invalidationWindowMs: 1000,
    clock: clock
  ) { _ in 1 }
  _ = try await window.fetch("a")
  await window.refresh("a", coalescing: true)
  await window.refresh("a", coalescing: true)
  owing.heard("p-res-1-7", in: resource)
  owing.store(.resource, resource, try keptDescriptor("owing"))
  owing.close()
  window.dispose()
  #expect(storage.get(documentKey)?.contains(#""owing""#) == true, "The documents are flushed")
  #expect(storage.get(placesKey) == nil, "A refetch owed at disposal holds the places back")

  let quiet = KeptQueries(persistence, clock: clock)
  #expect(quiet.attach(jo) == [:])
  quiet.heard("p-res-1-8", in: resource)
  quiet.store(.resource, resource, try keptDescriptor("quiet"))
  quiet.close()
  #expect(storage.get(documentKey)?.contains(#""quiet""#) == true)
  #expect(
    storedPlaces(storage.get(placesKey)) == [resource: "p-res-1-8"],
    "A save owed at disposal is the flush, and holds nothing back")
}

@Test func disposalWritesOnlyThePlacesNotedBeforeItReadTheGate() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let kept = MemorySignIn(
    HeldSignIn(
      access: "access", clientId: scriptClientID, personKey: jo, refresh: "refresh",
      tokenEndpoint: "http://issuer.test/token"))
  let resource = try ResourceId("res-1")
  let other = try ResourceId("res-2")
  // A session's client: its disposal's flush waits on the sign-in check, after the gate is read.
  let keeping = KeptQueries(
    CachePersistence(
      storage: storage, kbId: "kb", person: jo,
      writer: WritesWhileNamed(kept: kept, report: { _ in })),
    clock: TestClock())
  #expect(keeping.attach(jo) == [:])
  keeping.heard("p-res-1-8", in: resource)
  keeping.store(.resource, resource, try keptDescriptor("res-1"))
  keeping.close()
  keeping.heard("p-res-1-9", in: resource)
  keeping.heard("p-res-2-1", in: other)
  await keeping.closed()
  #expect(storage.get(cacheKey("kb", jo, .resource))?.contains(#""res-1""#) == true)
  #expect(storedPlaces(storage.get(lastEventIdKey("kb", jo))) == [resource: "p-res-1-8"])
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
  let key = "stamps"
  let first = StoragePersister<String>(storage: storage, storageKey: key)
  first.store("a", "one")
  first.close()
  let written = try storedJSON(storage.get(key))
  let again = StoragePersister<String>(storage: storage, storageKey: key)
  again.store("a", "one")
  again.close()
  #expect(try storedJSON(storage.get(key)) == written)
}

@Test func aDocumentTooLargeLosesTheEntriesReceivedLongestAgo() throws {
  let storage = MemorySessionStorage()
  let key = "large"
  let large = String(repeating: "x", count: Timings.maxStoredBytesCount * 2 / 5)
  storage.set(
    key, #"{"version":1,"entries":[["old","\#(large)",1],["mid","\#(large)",2]]}"#)
  let persister = StoragePersister<String>(storage: storage, storageKey: key)
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
  let key = "failing"
  let cache = Cache<String, String>(
    persister: StoragePersister(storage: storage, storageKey: key)
  ) { _ in
    throw BusRequestError(.busClosed, "The knowledge base is away")
  }
  await cache.set("kept", value: "a value")
  await cache.set("gone", value: "a value")
  #expect((try? await cache.fetch("kept")) == nil)
  await cache.remove("gone", gone: BusRequestError(.busNotFound, "gone"))
  cache.dispose()
  let entries = try required(storedJSON(storage.get(key)).object, "entries").array
  #expect(try entries.map { try $0.array[0].text } == ["kept"])
  #expect(try entries.map { try $0.array[1].text } == ["a value"])
}
