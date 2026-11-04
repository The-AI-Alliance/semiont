import Foundation
import SemiontTesting
import Synchronization
import Testing

@testable import Semiont

@Test func cacheStateUnitUsesTheSameQueriesAndDisposesOnlyItsOwnWork() async throws {
  let storage = MemorySessionStorage()
  let config = CachePersistence(storage: storage, keyPrefix: "parity-cache")
  let calls = Mutex<[String]>([])
  let cache = Cache<String, String>(persistence: config) { key in
    calls.withLock { $0.append(key) }
    return "value for \(key)"
  }
  let a = cache.observe("a")
  #expect(!(await cache.known("a")))
  #expect(try await cache.fetch("a") == "value for a")
  #expect(await cache.get("a") == "value for a")
  #expect(await cache.keys() == ["a"])
  await cache.set("b", value: "written")
  #expect(cache.persistencePending())
  // A separate observer is held until disposal.
  let settled = Watched(false)
  let watched = Task {
    var reader = a.makeAsyncIterator()
    guard case .ready("value for a")? = await reader.next() else {
      settled.set(true)
      return false
    }
    settled.set(true)
    if case .some = await reader.next() { return false }
    return true
  }
  try await within(1500) { for await ready in settled where ready { break } }
  cache.dispose()
  cache.dispose()
  #expect(await watched.value)
  #expect(!(await cache.known("a")))
  #expect(!cache.persistencePending())
  let restored = Cache<String, String>(persistence: config) { _ in "fresh" }
  defer { restored.dispose() }
  #expect(await restored.get("b") == "written")
  #expect(Set(await restored.keys()) == ["a", "b"])
  await restored.remove("b", gone: BusRequestError(.busNotFound, "gone"))
  #expect(await restored.get("b") == nil)
  #expect(await restored.known("b"))
}

@Test func sessionStateUnitEndsItsReadoutsAndLeavesItsClientOpen() async throws {
  let test = try await createTestSession(
    TestSessionOptions(kb: KbTarget(endpoint: registryEndpoint, id: "session", label: "KB")))
  let session = test.opened.session
  let transport = test.transport
  defer { test.opened.dispose() }
  try await session.ready()
  session.dispose()
  session.dispose()
  #expect(try await StateReading(session.token).ended())
  #expect(try await StateReading(session.user).ended())
  #expect(transport.state.value == .open)
  try session.client.bus.emit(Channels.yieldClone, BusEmptyPayload())
}

private var registryEndpoint: KbEndpoint {
  .httpEndpoint(HttpEndpoint(host: "localhost", port: 4000, protocol: .http))
}

@Test func registrySharesOpenResourcesAndDetectsAChangedKnowledgeBase() async throws {
  let storage = SharedStorage()
  let address = Mutex("example.org")
  let resource = try ResourceId("res-1")
  let description = try registryResource(resource)
  let factory = ScriptedSessions { _, channel, _ in
    switch channel {
    case Channels.browseKbRequested.name:
      try wirePayload(
        BrowseKbResult(
          response: KbDescription(domain: address.withLock { $0 }, gitBranch: "main", name: "KB")))
    case Channels.browseResourceRequested.name:
      try wirePayload(
        BrowseResourceResult(
          response: BrowseResourceResultResponse(lastSequence: 0, resource: description)))
    default: throw BusRequestError(.busNotFound, "Gone")
    }
  }
  let browser = try await newSemiontBrowser(
    SemiontBrowserConfig(storage: storage, sessionFactory: factory))
  let peer = try await newSemiontBrowser(
    SemiontBrowserConfig(storage: storage.context(), sessionFactory: factory))
  let token = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let session = HeldSignIn(
    access: token, clientId: "browser", refresh: "refresh", tokenEndpoint: "issuer")
  do {
    let first = try await browser.signedIn(
      SignedIn(
        endpoint: registryEndpoint,
        description: KbDescription(domain: "example.org", name: "First"),
        session: session))
    let id = first.kb.id
    #expect(browser.activeSession.value?.session.kb.id == id)
    try await within(2000) {
      for await opened in browser.activeSession where opened?.session.kb.id == id { break }
      for await opened in peer.activeSession where opened?.session.kb.id == id { break }
    }
    #expect(try await browser.kbSessionStatus(id) == .authenticated)
    try await browser.addOpenResource(resource, name: "Opened")
    try await browser.setLastViewedResource(resource)
    try await within(2000) {
      for await open in peer.openResources where open.first?.id == resource { break }
      for await viewed in peer.lastViewedResource where viewed == resource { break }
    }
    address.withLock { $0 = "elsewhere.example.org" }
    let check = try await browser.readActiveKb()
    #expect(check.kind == .conflict)
    #expect(browser.openResources.value.map(\.id) == [resource])
    try await browser.signIn(id, session: session)
    let signals = try await within(2000) {
      for await signals in browser.activeSignals {
        guard let signals else { continue }
        for await conflict in signals.kbIdentityConflict {
          if let conflict { return conflict }
        }
      }
      throw SpecFailure.shape("No identity conflict")
    }
    #expect(signals.expectedDid == "did:web:example.org")
    #expect(signals.observedDid == "did:web:elsewhere.example.org")
    #expect(browser.openResources.value.isEmpty)
    #expect(browser.lastViewedResource.value == nil)
    let second = try await browser.signedIn(
      SignedIn(
        endpoint: registryEndpoint,
        description: KbDescription(domain: "elsewhere.example.org", name: "Other"),
        session: session, kbId: id))
    #expect(second.kb.id != id)
    #expect(second.expected?.did == "did:web:example.org")
    #expect(browser.knowledgeBases.value.count == 2)
    try await browser.signOut(id)
    #expect(try await browser.kbSessionStatus(id) == .signedOut)
    try await within(1000) {
      while await factory.revoked.isEmpty { try await Task.sleep(for: .milliseconds(2)) }
    }
  } catch {
    try? await peer.close()
    try? await browser.close()
    throw error
  }
  try await peer.close()
  try await browser.close()
  #expect(await factory.revoked.count == 1)
}

private func registryResource(_ id: ResourceId) throws -> ResourceDescriptor {
  try decoded(
    ResourceDescriptor.self,
    .object([
      "@context": .string("https://schema.org"), "@id": .string(id.value),
      "name": .string("Resource"),
      "representations": .array([.object(["mediaType": .string("text/plain")])]),
    ]))
}

@Test func testingProductChecksLivenessAndDelivery() async throws {
  #expect(faultSchedules(8) == faultSchedules(8))
  let result = try wirePayload(
    BrowseKbResult(response: KbDescription(domain: "example.org", name: "KB")))
  let spec = LivenessSpec(
    timeout: .milliseconds(500), retryBudget: 0,
    schedules: [
      [.deliver], [.dropReply], [.delay(.milliseconds(5))], [.duplicateReply], [.rejectEmit],
    ],
    respond: { _, _ in result },
    setup: { transport in
      let client = try await SemiontClient(transport: transport)
      let request = Task { try await client.browse.kb() }
      return LivenessScenario(
        outputs: [{ _ = await request.result }], settlements: [{ _ = await request.result }],
        dispose: { client.dispose() })
    })
  try await assertLivenessAxioms(spec)
  let operations = deliveryOps(20, longest: 8)
  try await assertExactlyOnceDelivery(operations) { DeliveryProbe(losesOnTransition: false) }
  await #expect(throws: AxiomViolation.self) {
    try await assertExactlyOnceDelivery([[.write, .transition]]) {
      DeliveryProbe(losesOnTransition: true)
    }
  }
}

private actor DeliveryProbe: DeliverySubject {
  let losesOnTransition: Bool
  var ids: [String] = []

  init(losesOnTransition: Bool) { self.losesOnTransition = losesOnTransition }
  func write(_ eventId: String) { ids.append(eventId) }
  func transition() { if losesOnTransition { ids.removeAll() } }
  func delivered() -> [String] { ids }
}
