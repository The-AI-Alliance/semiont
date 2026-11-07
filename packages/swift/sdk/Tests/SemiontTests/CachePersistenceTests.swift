import Foundation
import SemiontTesting
import Synchronization
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

@Test func aDisposalThatOwesNoSaveWritesNoPlaces() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let placesKey = lastEventIdKey("kb", jo)
  let documentKey = cacheKey("kb", jo, .resource)
  let resource = try ResourceId("res-1")
  let clock = TestClock()
  let keeping = KeptQueries(
    CachePersistence(storage: storage, kbId: "kb", personKey: jo), clock: clock)
  #expect(keeping.attach(jo) == [:])
  keeping.heard("p-res-1-6", in: resource)
  keeping.store(.resource, resource, try keptDescriptor("one"))
  try await saved(storage, documentKey, on: clock) { $0.contains(#""one""#) }
  #expect(storedPlaces(storage.get(placesKey)) == [resource: "p-res-1-6"])
  keeping.heard("p-res-1-7", in: resource)
  keeping.close()
  #expect(storage.get(documentKey)?.contains(#""one""#) == true)
  #expect(
    storedPlaces(storage.get(placesKey)) == [resource: "p-res-1-6"],
    "A place is written only in the same call as a write of a kept cache")
}

@Test func keepingThatStartsOverAKeyWhoseFetchFailedLeavesWhatWasKept() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let resource = try ResourceId("res-1")
  let documentKey = cacheKey("kb", jo, .resource)
  let earlier = KeptQueries(
    CachePersistence(storage: storage, kbId: "kb", personKey: jo), clock: ContinuousClock())
  #expect(earlier.attach(jo) == [:])
  earlier.store(.resource, resource, try keptDescriptor("kept"))
  earlier.close()
  let kept = try #require(storage.get(documentKey))

  // The key's fetch fails before the gateway names the person.
  let probe = ProbeTransport()
  probe.setFailure(BusRequestError(.busRejected, "The knowledge base refused"))
  let client = try await SemiontClient(
    transport: probe,
    persistence: CachePersistence(
      storage: storage, kbId: "kb", person: nil, writer: WritesAsGiven()))
  let reading = client.browse.live.resources.observe(resource)
  try await withinTestDeadline {
    for await state in reading {
      if case .failed = state { return }
    }
    throw SpecFailure.shape("The query ended before its fetch failed")
  }
  await client.attach(jo)
  client.dispose()
  #expect(storage.get(documentKey) == kept, "A failed fetch leaves what was kept as it was")
}

// B17 item 1: nothing is owed before the person is named, and attaching writes nothing.
@Test func attachingWritesNothingThoughTheCachesHoldValues() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let resource = try ResourceId("res-1")
  let documentKey = cacheKey("kb", jo, .resource)
  let earlier = KeptQueries(
    CachePersistence(storage: storage, kbId: "kb", personKey: jo), clock: ContinuousClock())
  #expect(earlier.attach(jo) == [:])
  earlier.store(.resource, resource, try keptDescriptor("res-1"))
  earlier.close()
  let kept = try #require(storage.get(documentKey))

  // The caches hold answers before the gateway names the person.
  let fresh = try decoded(
    ResourceDescriptor.self,
    .object([
      "@context": .string("https://schema.org/"), "@id": .string("res-1"),
      "name": .string("fresh"), "representations": .array([]),
    ]))
  let probe = ProbeTransport()
  probe.handle { operation, _ in
    guard operation == Operations.browseResourceRequested.request.name else {
      throw SpecFailure.shape("Unscripted request: \(operation)")
    }
    return try wirePayload(
      BrowseResourceResult(
        response: BrowseResourceResultResponse(lastSequence: 1, resource: fresh)))
  }
  let client = try await SemiontClient(
    transport: probe,
    persistence: CachePersistence(
      storage: storage, kbId: "kb", person: nil, writer: WritesAsGiven()))
  _ = try await client.browse.live.resources.fetch(resource)
  await client.browse.live.entityTypes.replace(.ready(["Person"]))
  await client.attach(jo)
  client.dispose()
  #expect(storage.get(documentKey) == kept, "Attaching writes nothing over what was kept")
  #expect(
    storage.get(cacheKey("kb", jo, .entityTypes)) == nil, "Attaching writes nothing new")
}

// B17 item 1: what a cache held before its client kept anything is written with its next change,
// whose save writes the whole document: a value held in place of the one kept, nothing of an
// entity gone, and what was kept of a key the cache did not hold.
@Test func theNextChangeAfterAttachingWritesWhatTheCacheHeldBeforeIt() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let ids = try ["res-1", "res-2", "res-3", "res-4", "res-5"].map { try ResourceId($0) }
  let documentKey = cacheKey("kb", jo, .resource)
  let earlier = KeptQueries(
    CachePersistence(storage: storage, kbId: "kb", personKey: jo), clock: ContinuousClock())
  #expect(earlier.attach(jo) == [:])
  for id in ids.prefix(3) { earlier.store(.resource, id, try keptDescriptor("kept")) }
  earlier.close()

  // Before the gateway names the person: res-1 is answered, res-2's entity is gone, and res-4,
  // which nothing kept, is answered too.
  let probe = ProbeTransport()
  probe.handle { operation, _ in
    guard operation == Operations.browseResourceRequested.request.name else {
      throw SpecFailure.shape("Unscripted request: \(operation)")
    }
    return try wirePayload(
      BrowseResourceResult(
        response: BrowseResourceResultResponse(
          lastSequence: 1, resource: try keptDescriptor("fresh"))))
  }
  let client = try await SemiontClient(
    transport: probe,
    persistence: CachePersistence(
      storage: storage, kbId: "kb", person: nil, writer: WritesAsGiven()))
  let live = client.browse.live
  _ = try await live.resources.fetch(ids[0])
  await live.resources.remove(ids[1], gone: BusRequestError(.busNotFound, "res-2 is gone"))
  _ = try await live.resources.fetch(ids[3])
  await client.attach(jo)
  #expect(client.keeping?.pending == false, "Attaching owes no save")

  await live.resources.set(ids[4], value: try keptDescriptor("changed"))
  client.dispose()
  var names: [String: String] = [:]
  for entry in try required(storedJSON(storage.get(documentKey)).object, "entries").array {
    let parts = try entry.array
    names[try parts[0].text] = try required(parts[1].object, "name").text
  }
  #expect(names == ["res-1": "fresh", "res-3": "kept", "res-4": "fresh", "res-5": "changed"])
}

@Test func aStandaloneCacheSkipsAKeptEntryWhoseValueIsNotItsType() async throws {
  let storage = MemorySessionStorage()
  let key = "typed"
  storage.set(key, #"{"version":1,"entries":[["good",1,1],["bad","one",2]]}"#)
  let cache = Cache<String, Int>(
    persister: StoragePersister(storage: storage, storageKey: key)
  ) { key in
    throw BusRequestError(.busClosed, "A cache that is only read and set fetched \(key)")
  }
  #expect(await cache.get("good") == 1, "The other entries load")
  #expect(await cache.get("bad") == nil)
  await cache.set("new", value: 2)
  cache.dispose()
  let entries = try required(storedJSON(storage.get(key)).object, "entries").array
  #expect(
    Set(try entries.map { try $0.array[0].text }) == ["good", "new"],
    "An entry whose value is not the cache's is dropped, and written no more")
}

/// A `mark:archived` event of `resource` whose id is `id`, as the stream delivers it.
private func archived(_ resource: ResourceId, id: String) throws -> ReceivedFrame {
  let event = StoredEventResponse(
    id: id, metadata: EventMetadata(sequenceNumber: 1), payload: [:], resourceId: resource,
    timestamp: "2026-11-07T00:00:00.000Z", type: Channels.markArchived.name,
    userId: try UserId("did:web:example.org:users:alice"), version: 1)
  return ReceivedFrame(
    channel: Channels.markArchived.name, eventId: id, payload: try wirePayload(event),
    scope: resource)
}

/// Delivers a frame no query is refreshed by, and waits until `client` has bridged it: so each
/// frame delivered before it has been applied, and its place noted.
private func drained(_ probe: ProbeTransport, _ client: SemiontClient) async throws {
  let marks = client.bus.listen(["test:drained"])
  probe.deliver(.frame(ReceivedFrame(channel: "test:drained", payload: [:])))
  try await withinTestDeadline {
    for try await _ in marks { return }
    throw SpecFailure.shape("The bus ended before the frame came")
  }
}

// B17 item 2: an id is noted only once the refresher has taken its event. A guard: the client's
// pump applies each frame before it notes the frame's id, and has no queue between the transport
// and the refresher in which a frame could wait with its id noted.
@Test func aPlaceIsNotedOnceTheRefresherHasTakenItsEventAndItsFetchHoldsItBack() async throws {
  let storage = MemorySessionStorage()
  let jo = try joKey()
  let placesKey = lastEventIdKey("kb", jo)
  let clock = TestClock()
  let held = try ResourceId("res-1")
  let unheld = try ResourceId("res-2")
  let asked = Mutex(0)
  let (refetched, reached) = AsyncStream<Void>.makeStream()
  let (answered, answer) = AsyncStream<Void>.makeStream()
  let probe = ProbeTransport()
  probe.handle { operation, _ in
    guard operation == Operations.browseResourceRequested.request.name else {
      throw SpecFailure.shape("Unscripted request: \(operation)")
    }
    // The first ask is answered at once; one asked again waits until the test answers it.
    let count = asked.withLock { count in
      count += 1
      return count
    }
    if count > 1 {
      reached.yield()
      for await _ in answered { break }
    }
    return try wirePayload(
      BrowseResourceResult(
        response: BrowseResourceResultResponse(
          lastSequence: 1, resource: try keptDescriptor("res-1"))))
  }
  let client = try await SemiontClient(
    transport: probe, persistence: CachePersistence(storage: storage, kbId: "kb", personKey: jo),
    clock: clock)
  defer {
    answer.finish()
    client.dispose()
  }
  _ = try await client.browse.live.resources.fetch(held)

  // A place noted while nothing is unsettled is written with the next save.
  probe.deliver(.frame(try archived(unheld, id: "p-res-2-1")))
  try await drained(probe, client)
  try await saved(storage, cacheKey("kb", jo, .resource), on: clock) { _ in true }
  #expect(storedPlaces(storage.get(placesKey)) == [unheld: "p-res-2-1"])

  // The refresher has taken this event: the refetch it started is in flight, and its id noted.
  probe.deliver(.frame(try archived(held, id: "p-res-1-7")))
  try await withinTestDeadline {
    for await _ in refetched { return }
    throw SpecFailure.shape("The refresher did not ask again")
  }
  try await drained(probe, client)
  await client.browse.live.entityTypes.replace(.ready(["Person"]))
  try await saved(storage, cacheKey("kb", jo, .entityTypes), on: clock) { _ in true }
  #expect(
    storedPlaces(storage.get(placesKey)) == [unheld: "p-res-2-1"],
    "A fetch in flight holds back the place of the event that started it")
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
  let first = StoragePersister<String, String>(storage: storage, storageKey: key)
  first.store("a", "one")
  first.close()
  let written = try storedJSON(storage.get(key))
  let again = StoragePersister<String, String>(storage: storage, storageKey: key)
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
  let persister = StoragePersister<String, String>(storage: storage, storageKey: key)
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
