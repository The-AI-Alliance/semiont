import Foundation
import SemiontTesting
import Synchronization
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

  // Every member is read, and a renewal changes the tokens alone: the person a sign-in names stays.
  try storage.set(sessionKey(id), storedText(values))
  let full = try #require(try storedSession(storage, kbId: id))
  #expect(try encoded(full) == .object(values))
  #expect(
    try await kept.renewed(read: full, access: "renewed-access", refresh: "renewed-refresh")
      == "renewed-access")
  let renewed = try #require(try storedSession(storage, kbId: id))
  let tokens: [String: JSONValue] = [
    "access": .string("renewed-access"), "refresh": .string("renewed-refresh"),
  ]
  let renewedValues = values.merging(tokens) { _, new in new }
  #expect(try encoded(renewed) == .object(renewedValues))

  try clearStoredSession(storage, kbId: id)
  #expect(try await kept.renewed(read: read, access: "stale", refresh: "stale") == nil)
  #expect(try storedSession(storage, kbId: id) == nil)
}

@Test func everyKeyKeptForAPersonIsWorkedOutAsTheStoredTablesExample() throws {
  let table = try Spec.read("session/stored.json").object
  let stream = try required(table, "lastEventIdKeyPrefix").object
  let streamExample = try required(stream, "example").object
  let streamKey = lastEventIdKey(
    try required(streamExample, "kbId").text,
    personKey(try UserId(required(streamExample, "did").text)))
  let streamPrefix = try required(stream, "prefix").text
  #expect(streamKey == (try required(streamExample, "key").text))
  #expect(streamKey.hasPrefix(streamPrefix))

  let cache = try required(table, "cacheKeyPrefix").object
  let cacheExample = try required(cache, "example").object
  let query = try #require(KeptQuery(rawValue: try required(cacheExample, "query").text))
  let queryKey = cacheKey(
    try required(cacheExample, "kbId").text,
    personKey(try UserId(required(cacheExample, "did").text)), query)
  let cachePrefix = try required(cache, "prefix").text
  #expect(queryKey == (try required(cacheExample, "key").text))
  #expect(queryKey.hasPrefix(cachePrefix))
}

@Test func aSignInRecordsItsPersonOnceAndOnlyWhileItHoldsTheTokenAskedAbout() async throws {
  let hour = Date().timeIntervalSince1970 + 3600
  let first = try jwt(.object(["exp": .number(hour), "name": .string("first")]))
  let second = try jwt(.object(["exp": .number(hour), "name": .string("second")]))
  let jo = personKey(try UserId("did:web:kb.example.org:users:jo%40example.org"))
  let ann = personKey(try UserId("did:web:kb.example.org:users:ann%40example.org"))
  let signedIn = HeldSignIn(
    access: first, clientId: scriptClientID, refresh: "refresh",
    tokenEndpoint: "http://issuer.test/token")
  let storage = MemorySessionStorage()
  try storeSession(storage, kbId: "kb-a", session: signedIn)
  let keepers: [(String, any SignInKept)] = [
    ("the registry's", keptIn(storage, kbId: "kb-a")), ("one in memory", MemorySignIn(signedIn)),
  ]
  for (which, kept) in keepers {
    #expect(try await kept.recordPersonKey(holding: second, jo) == false, "\(which): moved on")
    #expect(try await kept.held()?.personKey == nil, "\(which)")
    #expect(try await kept.recordPersonKey(holding: first, jo), "\(which): recorded")
    #expect(try await kept.held()?.personKey == jo, "\(which)")
    #expect(try await kept.held()?.access == first, "\(which): the tokens stay")
    #expect(try await kept.recordPersonKey(holding: first, jo), "\(which): already recorded")
    #expect(try await kept.recordPersonKey(holding: first, ann) == false, "\(which): another")
    #expect(try await kept.held()?.personKey == jo, "\(which): never overwritten")
    let held = try #require(try await kept.held())
    #expect(try await kept.renewed(read: held, access: second, refresh: "renewed") == second)
    #expect(try await kept.held()?.personKey == jo, "\(which): a renewal keeps the person")
    #expect(try await kept.recordPersonKey(holding: second, jo), "\(which): after the renewal")
    try await kept.forget()
    #expect(try await kept.recordPersonKey(holding: second, jo) == false, "\(which): nothing kept")
  }
}

@Test func keepingANewSignInForgetsWhatWasKeptForThePersonTheOldOneNamed() async throws {
  let hour = Date().timeIntervalSince1970 + 3600
  let jo = personKey(try UserId("did:web:kb.example.org:users:jo%40example.org"))
  let ann = personKey(try UserId("did:web:kb.example.org:users:ann%40example.org"))
  func signIn(_ tokens: String, personKey: String?) throws -> HeldSignIn {
    HeldSignIn(
      access: try jwt(.object(["exp": .number(hour), "name": .string(tokens)])),
      clientId: scriptClientID, personKey: personKey, refresh: tokens + "-refresh",
      tokenEndpoint: "http://issuer.test/token")
  }
  let joOnA = KeptQuery.allCases.map { cacheKey("kb-a", jo, $0) } + [lastEventIdKey("kb-a", jo)]
  let others = [
    cacheKey("kb-a", ann, .resource), lastEventIdKey("kb-a", ann), cacheKey("kb-b", jo, .resource),
    lastEventIdKey("kb-b", jo),
  ]
  // The sign-in kb-a holds before the new one is kept, and whether jo's keys there go.
  let befores: [(String, HeldSignIn?, Bool)] = try [
    ("over a sign-in naming jo", signIn("old", personKey: jo), true),
    ("over a sign-in naming nobody", signIn("old", personKey: nil), false),
    ("over nothing", nil, false),
  ]
  for (why, before, forgets) in befores {
    let storage = MemorySessionStorage()
    for key in joOnA + others { storage.set(key, "kept") }
    if let before { try storeSession(storage, kbId: "kb-a", session: before) }
    let kept = keptIn(storage, kbId: "kb-a")
    let next = try signIn("new", personKey: nil)
    try await kept.keep(next)
    let now = try storedSession(storage, kbId: "kb-a")
    #expect(now?.access == next.access, "\(why): the new sign-in is kept")
    #expect(now?.personKey == nil, "\(why): the new sign-in names nobody")
    for key in joOnA { #expect((storage.get(key) == nil) == forgets, "\(why): \(key)") }
    for key in others { #expect(storage.get(key) == "kept", "\(why): \(key) changed") }
  }

  // A renewal is no replacement: it keeps the person, and deletes nothing.
  let storage = MemorySessionStorage()
  for key in joOnA { storage.set(key, "kept") }
  let named = try signIn("old", personKey: jo)
  try storeSession(storage, kbId: "kb-a", session: named)
  let renewed = try signIn("renewed", personKey: nil).access
  #expect(
    try await keptIn(storage, kbId: "kb-a").renewed(
      read: named, access: renewed, refresh: "renewed-refresh") == renewed)
  #expect(try storedSession(storage, kbId: "kb-a")?.personKey == jo, "a renewal keeps the person")
  for key in joOnA { #expect(storage.get(key) == "kept", "a renewal deleted \(key)") }
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

@Test func aClientKeepsThePersistedQueriesUnderItsPrefix() async throws {
  let table = try Spec.read("session/stored.json").object
  let prefix = try required(required(table, "cacheKeyPrefix").object, "prefix").text
  let whole = try required(required(table, "wholeKey").object, "key").text
  let version = try required(
    required(required(required(table, "cacheDocument").object, "properties").object, "version")
      .object, "const")
  // Each query client/refresh.json marks persisted, and the key its entry is kept under, by the
  // query's `per`: the resource `hold` holds, the annotation it holds, or the whole key.
  var kept: [String: JSONValue] = [:]
  for row in try required(Spec.read("client/refresh.json").object, "queries").array {
    let row = try row.object
    guard row["persisted"] == .bool(true) else { continue }
    let name = try required(row, "name").text
    switch try row["per"]?.text {
    case nil: kept[name] = .string(whole)
    case "resource"?: kept[name] = .string("res-1")
    case "annotation"?: kept[name] = .string("ann-1")
    case .some(let per):
      throw SpecFailure.shape("\(name) is persisted per \(per), which keeps nothing")
    }
  }
  #expect(kept.values.contains(.string(whole)), "A query per nothing is kept")

  let storage = MemorySessionStorage()
  let jo = personKey(try UserId("did:web:kb.example.org:users:jo%40example.org"))
  let client = try await SemiontClient(
    transport: ProbeTransport(channels: bridgedChannels),
    persistence: CachePersistence(storage: storage, kbId: "kb-a", personKey: jo))
  for query in CacheQuery.allCases { try await hold(query, in: client.browse.live) }
  client.dispose()
  for query in CacheQuery.allCases {
    let name = query.rawValue
    let text = storage.get(prefix + "kb-a." + jo + "." + name)
    #expect(
      (text != nil) == (kept[name] != nil), "\(name) is kept as client/refresh.json marks it")
    guard let text, let key = kept[name] else { continue }
    let document = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)).object
    #expect(try required(document, "version") == version, "\(name)'s document's version")
    let keys = try required(document, "entries").array.map { try $0.array[0] }
    #expect(keys == [key], "\(name) keeps its one entry under the key its `per` gives")
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
  let jo = personKey(try UserId("did:web:kb.example.org:users:jo%40example.org"))
  let keeping = KeptQueries(
    CachePersistence(storage: storage, kbId: "kb-a", personKey: jo), clock: ContinuousClock())
  #expect(keeping.attach(jo) == [:])
  let resource = try ResourceId("res-1")
  keeping.heard("p-res-1-7", in: resource)
  keeping.store(.resource, resource, try keptDescriptor("res-1"))
  keeping.close()
  let written = try JSONDecoder().decode(
    JSONValue.self, from: Data(try #require(storage.get(prefix + "kb-a." + jo)).utf8)
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

/// Opens `resources` in a knowledge base a registry over `storage` signs in to, then closes that
/// registry, so that the next one over `storage` activates a session with them open; gives the
/// knowledge base's id. The knowledge base answers as its entry, and nothing else.
private func openedBeforeActivation(
  _ resources: [ResourceId], in storage: MemorySessionStorage
) async throws -> String {
  let opening = ScriptedSessions { _, channel, _ in
    guard channel == Channels.browseKbRequested.name else {
      throw BusRequestError(.busRejected, "Unread")
    }
    return try wirePayload(
      BrowseKbResult(response: KbDescription(domain: "example.org", name: "KB")))
  }
  let browser = try await newSemiontBrowser(
    SemiontBrowserConfig(storage: storage, sessionFactory: opening))
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
    for resource in resources { try await browser.addOpenResource(resource, name: resource.value) }
    try await browser.close()
    return kbId
  } catch {
    try? await browser.close()
    throw error
  }
}

@Test func activatingASessionChecksEveryOpenResourceAsTheOpenResourceCasesSay() async throws {
  let cases = try required(Spec.read("session/open-resource-cases.json").object, "cases").array
  #expect(!cases.isEmpty, "session/open-resource-cases.json holds cases")
  for value in cases {
    let row = try value.object
    let why = try required(row, "why").text
    let kb = try required(row, "kb").text
    let open = try required(row, "open").array.map { try ResourceId($0.text) }
    let answers = try required(row, "resources").object.mapValues { try $0.text }
    let asked = try Set(required(row, "asked").array.map { try $0.text })
    let stillOpen = try Set(required(row, "stillOpen").array.map { try $0.text })
    let storage = MemorySessionStorage()
    let kbId = try await openedBeforeActivation(open, in: storage)

    let requested = Mutex<Set<String>>([])
    let answering = ScriptedSessions { _, channel, payload in
      switch channel {
      case Channels.browseKbRequested.name:
        guard kb == "itself" else {
          throw BusRequestError(.busTimeout, "The knowledge base did not answer")
        }
        return try wirePayload(
          BrowseKbResult(response: KbDescription(domain: "example.org", name: "KB")))
      case Channels.browseResourceRequested.name:
        let id = try required(payload, "resourceId").text
        requested.withLock { _ = $0.insert(id) }
        switch answers[id] {
        case "ready"?:
          return try wirePayload(
            BrowseResourceResult(
              response: BrowseResourceResultResponse(
                lastSequence: 1, resource: try keptDescriptor(id))))
        case "gone"?: throw BusRequestError(.busNotFound, "Gone")
        case "unanswered"?:
          throw BusRequestError(.busTimeout, "The knowledge base did not answer")
        default: throw SpecFailure.shape("\(why): \(id) is no resource the case answers for")
        }
      default: throw BusRequestError(.busRejected, "Unread")
      }
    }
    // The checks' outcome is the first write of the open resources once the session activates.
    let written = try #require(storage.subscribe(openResourcesByKbKey))
    let browser = try await newSemiontBrowser(
      SemiontBrowserConfig(storage: storage, sessionFactory: answering))
    do {
      let checked = try await withinTestDeadline {
        for await text in written { return text }
        throw SpecFailure.shape("\(why): the open resources were never written")
      }
      let kept = try #require(
        decodedStorage([String: [OpenResource]].self, checked)?[kbId],
        "\(why): the knowledge base's open resources are written")
      #expect(Set(kept.map(\.id.value)) == stillOpen, "\(why): still open")
      #expect(requested.withLock { $0 } == asked, "\(why): asked for")
    } catch {
      try? await browser.close()
      throw error
    }
    try await browser.close()
  }
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
