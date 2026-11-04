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
  try clearStoredSession(storage, kbId: id)
  #expect(try await kept.renewed(read: read, access: "stale", refresh: "stale") == nil)
  #expect(try storedSession(storage, kbId: id) == nil)
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
