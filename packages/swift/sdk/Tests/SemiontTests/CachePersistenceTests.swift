import Testing

@testable import Semiont

@Test func aStreamPlaceIsWrittenOnlyWithTheCachesAndOnlyWhileTheyAreSettled() throws {
  let storage = MemorySessionStorage()
  let jo = personKey(try UserId("did:web:kb.example.org:users:jo%40example.org"))
  let persistence = CachePersistence(
    storage: storage, kbId: "kb-a", person: nil, writer: WritesAsGiven())
  let resource = try ResourceId("res-1")

  let unattached = KeptQueries(persistence, clock: ContinuousClock())
  unattached.heard("p-before", in: resource)
  unattached.store(.annotations, resource, ["before"])
  unattached.close()
  #expect(storage.get(cacheKey("kb-a", jo, .annotations)) == nil)
  #expect(storage.get(lastEventIdKey("kb-a", jo)) == nil)

  let first = KeptQueries(persistence, clock: ContinuousClock())
  #expect(first.attach(jo) == [:])
  #expect(first.attach(jo) == nil)
  first.heard("e-ignored", in: resource)
  first.heard("p-one-1", in: resource)
  first.store(.annotations, resource, ["one"])
  first.close()

  let busy = KeptQueries(persistence, clock: ContinuousClock())
  #expect(busy.attach(jo) == [resource: "p-one-1"])
  #expect(busy.load(.annotations, resource, as: [String].self) == ["one"])
  busy.begin()
  busy.heard("p-one-2", in: resource)
  busy.store(.annotations, resource, ["one", "two"])
  busy.close()
  busy.end()

  let restored = KeptQueries(persistence, clock: ContinuousClock())
  #expect(restored.attach(jo) == [resource: "p-one-1"])
  #expect(restored.keys(.annotations, as: ResourceId.self) == [resource])
  #expect(restored.load(.annotations, resource, as: [String].self) == ["one", "two"])
  restored.close()
}
