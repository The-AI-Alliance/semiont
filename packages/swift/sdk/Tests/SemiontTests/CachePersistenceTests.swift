import Testing

@testable import Semiont

@Test func aBookmarkCanOnlyAdvanceWithSettledCacheValues() throws {
  let storage = MemorySessionStorage()
  let config = CachePersistence(storage: storage, keyPrefix: "test")
  let resource = try ResourceId("one")
  let key = KeptQuery.annotations(resource)

  let first = CacheBook(config)
  first.heard("e-ignored", in: resource)
  first.heard("p-one-1", in: resource)
  first.store(key, ["one"])
  first.close()

  let busy = CacheBook(config)
  #expect(busy.bookmarks == [resource: "p-one-1"])
  #expect(busy.load(key, as: [String].self) == ["one"])
  busy.begin()
  busy.heard("p-one-2", in: resource)
  busy.store(key, ["one", "two"])
  busy.close()
  busy.end()

  let restored = CacheBook(config)
  #expect(restored.bookmarks == [resource: "p-one-1"])
  #expect(restored.load(key, as: [String].self) == ["one", "two"])
  restored.close()
}
