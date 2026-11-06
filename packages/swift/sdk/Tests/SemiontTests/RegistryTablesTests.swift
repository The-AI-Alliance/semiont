import Foundation
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
    #expect(try await kept.recordPersonKey(jo, holding: second) == false, "\(which): moved on")
    #expect(try await kept.held()?.personKey == nil, "\(which)")
    #expect(try await kept.recordPersonKey(jo, holding: first), "\(which): recorded")
    #expect(try await kept.held()?.personKey == jo, "\(which)")
    #expect(try await kept.held()?.access == first, "\(which): the tokens stay")
    #expect(try await kept.recordPersonKey(jo, holding: first), "\(which): already recorded")
    #expect(try await kept.recordPersonKey(ann, holding: first) == false, "\(which): another")
    #expect(try await kept.held()?.personKey == jo, "\(which): never overwritten")
    let held = try #require(try await kept.held())
    #expect(try await kept.renewed(read: held, access: second, refresh: "renewed") == second)
    #expect(try await kept.held()?.personKey == jo, "\(which): a renewal keeps the person")
    #expect(try await kept.recordPersonKey(jo, holding: second), "\(which): after the renewal")
    try await kept.forget()
    #expect(try await kept.recordPersonKey(jo, holding: second) == false, "\(which): nothing kept")
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
