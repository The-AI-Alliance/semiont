import Foundation
import SemiontTesting
import Testing

@testable import Semiont

@Test func registryStorageMatchesTheSharedKeysAndSessionShape() async throws {
  let table = try Spec.read("session/stored.json").object
  let keys = [
    "knowledgeBasesKey": knowledgeBasesKey,
    "activeKey": activeKey,
    "openResourcesByKbKey": openResourcesByKbKey,
    "lastViewedResourceByKbKey": lastViewedResourceByKbKey,
    "pendingAuthorizationKey": pendingAuthorizationKey,
  ]
  let expected = try required(table, "keys").array.map { value in
    let row = try value.object
    return (try required(row, "member").text, try required(row, "key").text)
  }
  #expect(keys == Dictionary(uniqueKeysWithValues: expected))
  let prefix = try required(required(table, "sessionKeyPrefix").object, "prefix").text
  let id = "one"
  #expect(sessionKey(id) == prefix + id)
  #expect(kbOfSessionKey(sessionKey(id)) == id)
  #expect(kbOfSessionKey(activeKey) == nil)

  let storage = MemorySessionStorage()
  let schema = try required(table, "storedSession").object
  let properties = try required(schema, "properties").object
  let members = try required(schema, "required").array.map { try $0.text }
  let values = properties.mapValues { _ in JSONValue.string("text") }
  for absent in members {
    try storage.set(sessionKey(id), storedText(values.filter { $0.key != absent }))
    #expect(try storedSession(storage, kbId: id) == nil)
  }
  let valid = values.filter { members.contains($0.key) }
  try storage.set(sessionKey(id), storedText(valid))
  let read = try #require(try storedSession(storage, kbId: id))
  #expect(try encoded(read) == .object(valid))
  let kept = keptIn(storage, kbId: id)
  #expect(
    try await kept.renewed(read: read, access: "new-access", refresh: "new-refresh") == "new-access"
  )
  #expect(try await kept.renewed(read: read, access: "stale", refresh: "stale") == "new-access")
  try clearStoredSession(storage, kbId: id)
  #expect(try await kept.renewed(read: read, access: "stale", refresh: "stale") == nil)
  #expect(try storedSession(storage, kbId: id) == nil)
}

/// Hold a value in `query`'s cache of a client's queries.
private func hold(_ query: CacheQuery, in live: LiveQueries) async throws {
  let resource = try ResourceId("res-1")
  let listed: JSONValue = .object([
    "resources": .array([]), "total": .number(0), "offset": .number(0), "limit": .number(10),
  ])
  switch query {
  case .resource: await live.resources.set(resource, value: try keptDescriptor("res-1"))
  case .annotations:
    await live.annotations.set(
      resource,
      value: GetAnnotationsResponse(
        annotations: [try keptAnnotation("ann-1", of: "res-1")], total: 1))
  case .annotation:
    let annotation = try keptAnnotation("ann-1", of: "res-1")
    await live.details.set(
      LiveQueries.AnnotationKey(resource: resource, annotation: annotation.id), value: annotation)
  case .events: await live.events.set(resource, value: [])
  case .referencedBy: await live.referencedBy.set(resource, value: [])
  case .resources:
    await live.listedResources.set(
      ResourceFilters(), value: try decoded(ListResourcesResponse.self, listed))
  case .matchedResources:
    var matched = try listed.object
    matched["matchKind"] = .string("lexical")
    await live.matchedResources.set(
      LiveQueries.SearchKey(text: "one", filters: ResourceFilters()),
      value: try decoded(MatchResourcesResponse.self, .object(matched)))
  case .entityTypes: await live.entityTypes.replace(.ready(["Person"]))
  case .tagSchemas: await live.tagSchemas.replace(.ready([]))
  case .engines: await live.engines.replace(.ready([]))
  }
}

@Test func aClientKeepsTheStoredTablesQueriesUnderItsPrefix() async throws {
  let table = try Spec.read("session/stored.json").object
  let prefix = try required(required(table, "cacheKeyPrefix").object, "prefix").text
  let kept = Set(
    try required(table, "keptQueries").array.map { try required($0.object, "query").text })
  let whole = try required(required(table, "wholeKey").object, "key").text
  let version = try required(
    required(required(required(table, "cacheDocument").object, "properties").object, "version")
      .object, "const")
  var perNothing: Set<String> = []
  for row in try required(Spec.read("client/refresh.json").object, "queries").array {
    let row = try row.object
    if row["per"] == nil { perNothing.insert(try required(row, "name").text) }
  }
  #expect(!kept.isDisjoint(with: perNothing), "A query per nothing is kept")

  let storage = MemorySessionStorage()
  let client = try await SemiontClient(
    transport: ProbeTransport(), persistence: CachePersistence(storage: storage, keyPrefix: "kb-a"))
  for query in CacheQuery.allCases { try await hold(query, in: client.browse.live) }
  client.dispose()
  for query in CacheQuery.allCases {
    let name = query.rawValue
    let text = storage.get(prefix + "kb-a." + name)
    #expect((text != nil) == kept.contains(name), "\(name) is kept as session/stored.json keeps it")
    guard let text else { continue }
    let document = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)).object
    #expect(try required(document, "version") == version, "\(name)'s document's version")
    let keys = try required(document, "entries").array.map { try $0.array[0] }
    if perNothing.contains(name) {
      #expect(keys == [.string(whole)], "\(name) keeps its one entry under the whole key")
    }
  }
}

@Test func placesAreKeptAsTheStoredTablesLastEventIds() throws {
  let table = try Spec.read("session/stored.json").object
  let prefix = try required(required(table, "lastEventIdKeyPrefix").object, "prefix").text
  let places = try required(table, "lastEventIds").object
  let schema = { (member: String) throws -> String in
    URL(fileURLWithPath: try required(required(places, member).object, "$ref").text)
      .deletingPathExtension().lastPathComponent
  }
  let scope = try schema("propertyNames")
  let place = try schema("additionalProperties")

  let storage = MemorySessionStorage()
  let keeping = Keeping(
    CachePersistence(storage: storage, keyPrefix: "kb-a"), clock: ContinuousClock())
  let book: StoragePersister<ResourceId, KeptResource> = try #require(
    keeping.persister(.resource))
  let resource = try ResourceId("res-1")
  keeping.places.heard("p-res-1-7", in: resource)
  book.store(resource, try keptDescriptor("res-1"))
  keeping.close()
  let written = try JSONDecoder().decode(
    JSONValue.self, from: Data(try #require(storage.get(prefix + "kb-a")).utf8)
  ).object
  #expect(written.count == 1)
  for (key, value) in written {
    #expect(faultOf(scope, .string(key)) == nil, "\(key) is a scope as \(scope) holds one")
    #expect(faultOf(place, value) == nil, "\(value) is a place as \(place) holds one")
  }
}

@Test func onePlaceRunsEverySharedCase() throws {
  for value in try required(Spec.read("session/registry-cases.json").object, "cases").array {
    let row = try value.object
    let why = try required(row, "why").text
    let one = try JSONDecoder().decode(
      KbEndpoint.self, from: JSONEncoder().encode(required(row, "one")))
    let other = try JSONDecoder().decode(
      KbEndpoint.self, from: JSONEncoder().encode(required(row, "other")))
    let same = try required(row, "samePlace")
    #expect(JSONValue.bool(samePlace(one, other)) == same, "\(why)")
    #expect(JSONValue.bool(samePlace(other, one)) == same, "\(why), the other way round")
  }
}

@Test func openResourcesAreShownInTheSharedOrder() throws {
  let rows = try required(Spec.read("session/registry-cases.json").object, "openResourceOrder")
    .array
  #expect(!rows.isEmpty)
  for value in rows {
    let row = try value.object
    let why = try required(row, "why").text
    let open = try #require(
      try decodedStorage([OpenResource].self, storedText(required(row, "open"))), "\(why)")
    let shown = try required(row, "shown").array.map { try $0.text }
    #expect(sortOpenResources(open).map(\.id.value) == shown, "\(why)")
  }
}

@Test func anOpenResourceIsKeptAsTheStoredTableStatesIt() async throws {
  let schema = try required(Spec.read("session/stored.json").object, "openResource").object
  let members = Set(try required(schema, "properties").object.keys)
  let requiredMembers = try required(schema, "required").array.map { try $0.text }
  let storage = MemorySessionStorage()
  let factory = ScriptedSessions { _, channel, _ in
    guard channel == Channels.browseKbRequested.name else {
      throw BusRequestError(.busRejected, "Unread")
    }
    return try wirePayload(
      BrowseKbResult(response: KbDescription(domain: "example.org", name: "KB")))
  }
  let browser = try await newSemiontBrowser(
    SemiontBrowserConfig(storage: storage, sessionFactory: factory))
  do {
    let token = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
    let signedIn = try await browser.signedIn(
      SignedIn(
        endpoint: .httpEndpoint(HttpEndpoint(host: "localhost", port: 4000, protocol: .http)),
        description: KbDescription(domain: "example.org", name: "KB"),
        session: HeldSignIn(
          access: token, clientId: "browser", refresh: "refresh", tokenEndpoint: "issuer")))
    let kbId = signedIn.kb.id
    try await withinTestDeadline {
      for await opened in browser.activeSession where opened?.session.kb.id == kbId { break }
    }
    try await browser.addOpenResource(
      try ResourceId("full"), name: "Full", mediaType: "text/markdown",
      storageUri: "file://docs/full.md")
    try await browser.addOpenResource(try ResourceId("bare"), name: "Bare")

    let text = try #require(storage.get(openResourcesByKbKey))
    let kept = try required(
      JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)).object, kbId
    ).array.map { try $0.object }
    let full = try #require(kept.first { $0["id"] == JSONValue.string("full") })
    let bare = try #require(kept.first { $0["id"] == JSONValue.string("bare") })
    #expect(Set(full.keys) == members)
    #expect(Set(bare.keys) == Set(requiredMembers))
    #expect(try decodedStorage(OpenResource.self, storedText(full)) != nil)
    for absent in requiredMembers {
      #expect(
        try decodedStorage(OpenResource.self, storedText(full.filter { $0.key != absent })) == nil,
        "without \(absent)")
    }
  } catch {
    try? await browser.close()
    throw error
  }
  try await browser.close()
}

@Test func discoveryMatchesTheSharedReasonsAndRejectsAnInvalidMember() async throws {
  let table = try Spec.read("client/discovery-absent.json").object
  let expected = try required(table, "reasons").array.map { try required($0.object, "reason").text }
  #expect(Set(DiscoveryAbsentReason.allCases.map(\.rawValue)) == Set(expected))

  func absentReason(_ state: DiscoveryState) -> DiscoveryAbsentReason? {
    if case .absent(let absent) = state { return absent.reason }
    return nil
  }
  #expect(absentReason(parseDiscoveryDocument("{")) == .notJSON)
  #expect(absentReason(parseDiscoveryDocument(#"{"version":2,"kbs":[]}"#)) == .unsupportedVersion)
  #expect(absentReason(parseDiscoveryDocument(#"{"version":1,"kbs":[{}]}"#)) == .invalid)
  guard case .managed(let empty) = parseDiscoveryDocument(#"{"version":1,"kbs":[]}"#) else {
    Issue.record(
      "A launcher with no knowledge bases must be distinguishable from an absent launcher")
    return
  }
  #expect(empty.kbs.isEmpty)

  let noFile = textDiscovery { throw CocoaError(.fileReadNoSuchFile) }
  let noAccess = textDiscovery { throw CocoaError(.fileReadNoPermission) }
  if case .state(let state) = await noFile.read() {
    #expect(absentReason(state) == .notFound)
  } else {
    Issue.record("Expected an absent launcher")
  }
  if case .state(let state) = await noAccess.read() {
    #expect(absentReason(state) == .unreadable)
  } else {
    Issue.record("Expected an absent launcher")
  }
}

@Test func redirectSignInUsesTheRFC7636ChallengeVector() {
  #expect(
    codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
      == "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
}

private actor DiscoveryScript: DiscoveryTransport {
  private var answers: [DiscoveryRead]

  init(_ answers: [DiscoveryRead]) { self.answers = answers }

  func read() -> DiscoveryRead {
    answers.isEmpty ? .unchanged(Unchanged()) : answers.removeFirst()
  }
}

@Test func launcherDiscoveryReportsChangesAndSkipsUnchangedReads() async throws {
  let first = DiscoveredKB(
    did: "did:web:one.test", host: "localhost", managedBy: "launcher",
    placement: .local, port: 4001, siteName: "First")
  var renamed = first
  renamed.siteName = "Renamed"
  let second = DiscoveredKB(
    did: "did:web:two.test", host: "localhost", managedBy: "launcher",
    placement: .local, port: 4002, siteName: "Second")
  let script = DiscoveryScript([
    .state(.managed(Managed(kbs: [first]))), .unchanged(Unchanged()),
    .state(.managed(Managed(kbs: [first]))),
    .state(.managed(Managed(kbs: [renamed, second, second]))),
    .state(.absent(Absent(reason: .notFound))),
  ])
  try await withinTestDeadline {
    let updates = subscribeDiscovery(script, interval: .milliseconds(1))
    var iterator = updates.makeAsyncIterator()
    let initial = try #require(await iterator.next())
    #expect(initial.added.map(\.port) == [4001])
    let change = try #require(await iterator.next())
    #expect(change.added.map(\.port) == [4002, 4002])
    #expect(change.updated.map(\.siteName) == ["Renamed"])
    #expect(change.duplicated == ["localhost:4002"])
    let removed = try #require(await iterator.next())
    #expect(removed.removed.map(\.port) == [4001, 4002, 4002])
    guard case .absent(let absent) = removed.state else {
      Issue.record("Expected an absent launcher")
      return
    }
    #expect(absent.reason == .notFound)
  }
}
