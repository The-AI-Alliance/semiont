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
      writer: WritesWhileNamed(kept: kept, report: { _, _ in })),
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
  let probe = ProbeTransport(channels: bridgedChannels)
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
  let probe = ProbeTransport(channels: bridgedChannels)
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
  let probe = ProbeTransport(channels: bridgedChannels)
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
  let firstAnswer = try keptDescriptor("res-1")
  let refetchAnswer = try decoded(
    ResourceDescriptor.self,
    .object([
      "@context": .string("https://schema.org/"), "@id": .string("res-1"),
      "name": .string("archived"), "representations": .array([]),
    ]))
  let probe = ProbeTransport(channels: bridgedChannels + ["test:drained"])
  probe.handle { operation, _ in
    guard operation == Operations.browseResourceRequested.request.name else {
      throw SpecFailure.shape("Unscripted request: \(operation)")
    }
    // The first ask is answered at once; one asked again waits until the test answers it.
    let count = asked.withLock { count in
      count += 1
      return count
    }
    guard count > 1 else {
      return try wirePayload(
        BrowseResourceResult(
          response: BrowseResourceResultResponse(lastSequence: 1, resource: firstAnswer)))
    }
    reached.yield()
    for await _ in answered { break }
    return try wirePayload(
      BrowseResourceResult(
        response: BrowseResourceResultResponse(lastSequence: 2, resource: refetchAnswer)))
  }
  let client = try await SemiontClient(
    transport: probe, persistence: CachePersistence(storage: storage, kbId: "kb", personKey: jo),
    clock: clock)
  defer {
    answer.finish()
    client.dispose()
  }
  _ = try await client.browse.live.resources.fetch(held)
  // The stream holds both resources' scopes, as a gateway sends a resource's events only then; only
  // res-1 has a value in the cache.
  let scopes = [await probe.subscribeToResource(held), await probe.subscribeToResource(unheld)]
  defer { for scope in scopes { scope.dispose() } }

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

  // Answered, and seen through a read that waits on the refetch: the save its value owes, fired
  // once, writes the place, the refetch having settled.
  let joined = SpawnWatch()
  let read = spawn {
    try await Spawning.$executor.withValue(joined) {
      try await client.browse.live.resources.fetch(held)
    }
  }
  try await withinTestDeadline {
    for await _ in joined.spawned { return }
    throw SpecFailure.shape("The read spawned nothing")
  }
  answer.yield()
  #expect(try await read.value.name == "archived")
  clock.advance(by: .milliseconds(Timings.saveDebounceMs))
  try await withinTestDeadline {
    while storedPlaces(storage.get(placesKey))[held] == nil { await Task.yield() }
  }
  #expect(storedPlaces(storage.get(placesKey)) == [unheld: "p-res-2-1", held: "p-res-1-7"])
  #expect(storage.get(cacheKey("kb", jo, .resource))?.contains("archived") == true)
}

/// Runs each job it is given on the global executor, and says it was given one. Bound as the
/// executor the SDK spawns on for a read, its first job is the read's first task: in a read of a
/// query, the wait on the fetch it joined or began.
private final class SpawnWatch: TaskExecutor {
  let spawned: AsyncStream<Void>
  private let given: AsyncStream<Void>.Continuation

  init() { (spawned, given) = AsyncStream<Void>.makeStream() }

  func enqueue(_ job: consuming ExecutorJob) {
    given.yield()
    globalConcurrentExecutor.enqueue(job)
  }
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

/// A fetch every ask of which waits until the test answers it, the asks counted from 0.
private final class Asks: Sendable {
  private let waits = Mutex<[SharedWait<Int>]>([])

  func asked() async throws -> Int {
    let wait = SharedWait<Int>()
    waits.withLock { $0.append(wait) }
    return try await withCheckedThrowingContinuation { wait.install($0) }
  }

  /// How many asks have been made.
  var count: Int { waits.withLock { $0.count } }

  /// Returns once `count` asks have been made.
  func made(_ count: Int) async {
    while self.count < count { await Task.yield() }
  }

  func answer(_ nth: Int, _ value: Int) { waits.withLock { $0[nth] }.resolve(.success(value)) }

  func fail(_ nth: Int) {
    waits.withLock { $0[nth] }.resolve(.failure(SpecFailure.shape("The service is away")))
  }
}

private let keptKey = "kept"

/// A kept cache whose fetches the test answers: the read `older` has asked for "k" (F0), and
/// `observer` waits on that fetch.
private struct AskedOnce {
  let storage = MemorySessionStorage()
  let clock = TestClock()
  let asks = Asks()
  let persister: StoragePersister<String, Int>
  let cache: Cache<String, Int>
  let older: Task<Int, any Error>
  var observer: Cached<Int>.AsyncIterator

  init() async throws {
    persister = StoragePersister(storage: storage, storageKey: keptKey, clock: clock)
    let asks = self.asks
    let cache = Cache<String, Int>(persister: persister, clock: clock) { _ in
      try await asks.asked()
    }
    self.cache = cache
    older = spawn { try await cache.fetch("k") }
    await asks.made(1)
    observer = cache.observe("k").makeAsyncIterator()
    guard case .pending? = await observer.next() else {
      throw SpecFailure.shape("The key was not pending on its first fetch")
    }
  }

  /// What the storage holds of "k".
  var stored: Int? {
    StoragePersister<String, Int>(storage: storage, storageKey: keptKey).load("k")
  }
}

// B9: only a key's newest fetch writes. One an invalidation let go of answers its own read, and
// stores nothing: no value, no emission, no save.
@Test func aFetchAnInvalidationLetGoOfAnswersItsReadButStoresNothingThoughItAnswersLast()
  async throws
{
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    await asked.cache.invalidate("k")
    await asked.asks.made(2)
    asked.asks.answer(1, 5)
    guard case .ready(5)? = await asked.observer.next() else {
      throw SpecFailure.shape("The newest fetch's answer was not the key's value")
    }
    // Read through the cache, so after the step that settled the newest fetch.
    #expect(await asked.cache.get("k") == 5)
    try await saved(asked.storage, keptKey, on: asked.clock) { _ in true }
    #expect(asked.stored == 5)
    #expect(!asked.persister.pending)

    asked.asks.answer(0, 3)
    #expect(try await asked.older.value == 3, "The fetch let go of answers its own read")
    #expect(await asked.cache.get("k") == 5)
    #expect(!asked.persister.pending, "Its answer owes no save")
    #expect(asked.stored == 5)
    await asked.cache.set("k", value: 9)
    guard case .ready(9)? = await asked.observer.next() else {
      throw SpecFailure.shape("The fetch let go of emitted its answer")
    }
  }
}

// B9: the fetch an invalidation let go of, answered before the newest, leaves the key as it was.
@Test func aFetchAnInvalidationLetGoOfAnsweredFirstLeavesTheKeyToTheNewestFetch() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    await asked.cache.invalidate("k")
    await asked.asks.made(2)
    asked.asks.answer(0, 3)
    #expect(try await asked.older.value == 3, "The fetch let go of answers its own read")
    #expect(await asked.cache.get("k") == nil, "The key is still pending")

    asked.asks.answer(1, 5)
    guard case .ready(5)? = await asked.observer.next() else {
      throw SpecFailure.shape("The key's next state was not the newest fetch's answer")
    }
    #expect(await asked.cache.get("k") == 5)
    try await saved(asked.storage, keptKey, on: asked.clock) { _ in true }
    #expect(asked.stored == 5)
    #expect(!asked.persister.pending)
  }
}

// B17 and B9: a key is fetching while its newest fetch has not settled, and not for a fetch an
// invalidation let go of.
@Test func aKeyIsFetchingForItsNewestFetchAloneAndNotForOneAnInvalidationLetGoOf() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    #expect(!asked.persister.underway.settled, "The first fetch is in flight")
    await asked.cache.invalidate("k")
    #expect(!asked.persister.underway.settled, "The newest fetch is in flight in its place")
    await asked.asks.made(2)
    asked.asks.answer(1, 5)
    guard case .ready(5)? = await asked.observer.next() else {
      throw SpecFailure.shape("The newest fetch's answer was not the key's value")
    }
    // Read through the cache, so after the step that settled the newest fetch.
    #expect(await asked.cache.get("k") == 5)
    #expect(
      asked.persister.underway.settled,
      "The newest fetch settled: nothing is in flight, though the first never answered")

    asked.asks.answer(0, 3)
    #expect(try await asked.older.value == 3)
    #expect(asked.persister.underway.settled, "The first fetch's answer ends no count")
  }
}

// B13a: a removal lets go of the key's fetch, whose answer stores nothing.
@Test func aFetchARemovalLetGoOfStoresNothingWhenItIsAnswered() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    await asked.cache.remove("k", gone: BusRequestError(.busNotFound, "k is gone"))
    guard case .failed(let gone)? = await asked.observer.next() else {
      throw SpecFailure.shape("The removal did not fail the key")
    }
    #expect((gone as? BusRequestError)?.reason == .busNotFound)
    #expect(
      asked.persister.underway.settled, "The fetch the removal let go of is in flight no more")
    try await saved(asked.storage, keptKey, on: asked.clock) { _ in true }
    let written = asked.storage.get(keptKey)
    #expect(asked.stored == nil)

    asked.asks.answer(0, 3)
    #expect(try await asked.older.value == 3, "The fetch let go of answers its own read")
    #expect(await asked.cache.get("k") == nil)
    #expect(!asked.persister.pending, "Its answer owes no save")
    #expect(asked.storage.get(keptKey) == written)
    await asked.cache.set("k", value: 9)
    guard case .ready(9)? = await asked.observer.next() else {
      throw SpecFailure.shape("The fetch the removal let go of emitted its answer")
    }
  }
}

// B13b: a set lets go of the fetch in flight, asked before it, whose answer may be the value the
// set replaced. It answers its own read and stores nothing.
@Test func aSetLetsGoOfTheFetchInFlightWhoseAnswerStoresNothing() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    await asked.cache.set("k", value: 7)
    guard case .ready(7)? = await asked.observer.next() else {
      throw SpecFailure.shape("The set was not the key's value")
    }
    #expect(asked.persister.underway.settled, "The fetch the set let go of is in flight no more")
    try await saved(asked.storage, keptKey, on: asked.clock) { _ in true }
    #expect(asked.stored == 7)

    asked.asks.answer(0, 3)
    #expect(try await asked.older.value == 3, "The fetch let go of answers its own read")
    #expect(await asked.cache.get("k") == 7)
    #expect(!asked.persister.pending, "Its answer owes no save")
    #expect(asked.stored == 7)
    await asked.cache.set("k", value: 9)
    guard case .ready(9)? = await asked.observer.next() else {
      throw SpecFailure.shape("The fetch the set let go of emitted its answer")
    }
  }
}

// B13b and B14: a set lets go of the live view's ask with its fetch, so that fetch failing is
// asked no more and fails nothing.
@Test func aSetLetsGoOfTheLiveViewsAskSoItsFetchFailingAsksNothingMore() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    await asked.cache.set("k", value: 7)
    guard case .ready(7)? = await asked.observer.next() else {
      throw SpecFailure.shape("The set was not the key's value")
    }
    asked.asks.fail(0)
    let older = asked.older
    await #expect(throws: SpecFailure.self) { try await older.value }
    #expect(asked.persister.underway.settled, "Nothing is asked again")
    #expect(await asked.cache.get("k") == 7)
    await asked.cache.set("k", value: 9)
    guard case .ready(9)? = await asked.observer.next() else {
      throw SpecFailure.shape("The failure of the fetch the set let go of was published")
    }
    #expect(asked.asks.count == 1)
  }
}

// B13b: a patch to a key whose first fetch is in flight waits with that fetch, and is applied to
// its answer: what the key holds, and what the fetch's read is given.
@Test func aPatchToAKeyWhoseFirstFetchIsInFlightIsAppliedToItsAnswer() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    await asked.cache.patch("k") { $0 + 1 }
    #expect(await asked.cache.get("k") == nil, "Nothing holds a value to apply it to yet")
    asked.asks.answer(0, 5)
    #expect(try await asked.older.value == 6, "The fetch's read is given its answer patched")
    guard case .ready(6)? = await asked.observer.next() else {
      throw SpecFailure.shape("The key's first value was not its fetch's answer patched")
    }
    try await saved(asked.storage, keptKey, on: asked.clock) { _ in true }
    #expect(asked.stored == 6)
  }
}

// B13b: patches are applied in the order made, at once to the value held and to the answer of the
// fetch in flight, which they let go of nothing of.
@Test func patchesAreAppliedInTheOrderMadeAtOnceAndToTheAnswerOfTheFetchInFlight() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    asked.asks.answer(0, 1)
    guard case .ready(1)? = await asked.observer.next() else {
      throw SpecFailure.shape("The first fetch's answer was not the key's value")
    }
    await asked.cache.invalidate("k")
    await asked.asks.made(2)
    await asked.cache.patch("k") { $0 + 1 }
    await asked.cache.patch("k") { $0 * 2 }
    guard case .ready(2)? = await asked.observer.next(),
      case .ready(4)? = await asked.observer.next()
    else {
      throw SpecFailure.shape("The patches were not applied at once, in the order made")
    }
    asked.asks.answer(1, 10)
    guard case .ready(22)? = await asked.observer.next() else {
      throw SpecFailure.shape("The patches were not applied to the answer, in the order made")
    }
    // Read through the cache, so after the step that settled the fetch.
    #expect(await asked.cache.get("k") == 22)
    #expect(asked.persister.underway.settled, "Nothing more is asked")
    #expect(asked.asks.count == 2)
  }
}

// B13b: the patches kept with a fetch an invalidation replaced go with it. The newer fetch was asked
// after their events, so its answer holds what they did.
@Test func theFetchAnInvalidationReplacedTakesItsPatchesWithIt() async throws {
  try await withinTestDeadline {
    var asked = try await AskedOnce()
    defer { asked.cache.dispose() }
    await asked.cache.patch("k") { $0 + 1 }
    await asked.cache.invalidate("k")
    await asked.asks.made(2)
    asked.asks.answer(1, 10)
    guard case .ready(10)? = await asked.observer.next() else {
      throw SpecFailure.shape("The newer fetch's answer was not the key's value as it was")
    }
    asked.asks.answer(0, 3)
    #expect(try await asked.older.value == 3, "The fetch let go of answers its own read as it was")
    #expect(await asked.cache.get("k") == 10)
    await asked.cache.set("k", value: 9)
    guard case .ready(9)? = await asked.observer.next() else {
      throw SpecFailure.shape("The fetch let go of emitted its answer")
    }
  }
}

// B13b and B20: a patch to a key that holds neither a value nor a fetch does nothing.
@Test func aPatchToAKeyThatHoldsNeitherAValueNorAFetchDoesNothing() async throws {
  let storage = MemorySessionStorage()
  let clock = TestClock()
  let asks = Asks()
  let persister = StoragePersister<String, Int>(
    storage: storage, storageKey: keptKey, clock: clock)
  let cache = Cache<String, Int>(persister: persister, clock: clock) { _ in
    try await asks.asked()
  }
  defer { cache.dispose() }
  try await withinTestDeadline {
    await cache.patch("k") { $0 + 1 }
    #expect(await cache.known("k") == false)
    #expect(await cache.get("k") == nil)
    #expect(!persister.pending, "It owes no save")
    // Its first observer is shown the first fetch's answer as it is.
    var observer = cache.observe("k").makeAsyncIterator()
    guard case .pending? = await observer.next() else {
      throw SpecFailure.shape("The key was not pending on its first fetch")
    }
    await asks.made(1)
    asks.answer(0, 5)
    guard case .ready(5)? = await observer.next() else {
      throw SpecFailure.shape("The first fetch's answer was not the key's value as it was")
    }
  }
}

// B13b and B18: a patch leaves a restored value restored: one part of it is known to be current,
// the rest is not, so its first observation still asks for it anew.
@Test func aRestoredValueThatIsPatchedIsAskedForAnewWhenFirstObserved() async throws {
  let storage = MemorySessionStorage()
  storage.set(keptKey, #"{"version":1,"entries":[["k",1,1]]}"#)
  let clock = TestClock()
  let asks = Asks()
  let cache = Cache<String, Int>(
    persister: StoragePersister(storage: storage, storageKey: keptKey, clock: clock), clock: clock
  ) { _ in
    try await asks.asked()
  }
  defer { cache.dispose() }
  try await withinTestDeadline {
    await cache.patch("k") { $0 + 1 }
    #expect(await cache.get("k") == 2)
    #expect(asks.count == 0, "A patch asks nothing")
    var observer = cache.observe("k").makeAsyncIterator()
    guard case .ready(2)? = await observer.next() else {
      throw SpecFailure.shape("The patched restored value was not shown at once")
    }
    await asks.made(1)
    asks.answer(0, 5)
    guard case .ready(5)? = await observer.next() else {
      throw SpecFailure.shape("The restored value was not asked for anew")
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
