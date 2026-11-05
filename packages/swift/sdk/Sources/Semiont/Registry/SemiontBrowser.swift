import AsyncHTTPClient
import Foundation
import Synchronization

public struct SemiontBrowserConfig: Sendable {
  public let storage: any SessionStorage
  public let sessionFactory: any SessionFactory

  public init(storage: any SessionStorage, sessionFactory: any SessionFactory) {
    self.storage = storage
    self.sessionFactory = sessionFactory
  }
}

public struct SignedIn: Sendable {
  public let endpoint: KbEndpoint
  public let description: KbDescription
  public let session: HeldSignIn
  public let kbId: String?
  public let expectedDid: String?
  public let expectedName: String?

  public init(
    endpoint: KbEndpoint, description: KbDescription, session: HeldSignIn, kbId: String? = nil,
    expectedDid: String? = nil, expectedName: String? = nil
  ) {
    self.endpoint = endpoint
    self.description = description
    self.session = session
    self.kbId = kbId
    self.expectedDid = expectedDid
    self.expectedName = expectedName
  }
}

public struct Expected: Sendable {
  public let did: String
  public let name: String?
}

public struct SignInOutcome: Sendable {
  public let kb: KnowledgeBase
  public let expected: Expected?
}

public enum KbReadKind: String, Codable, Sendable {
  case recorded, conflict
  case noVerdict = "no-verdict"
}

public struct KbReadVerdict: Sendable {
  public let kind: KbReadKind
  public let observedDid: String?
  public let observedName: String?

  init(_ kind: KbReadKind, observedDid: String? = nil, observedName: String? = nil) {
    self.kind = kind
    self.observedDid = observedDid
    self.observedName = observedName
  }
}

public enum KbSessionStatus: String, Sendable {
  case authenticated, expired
  case signedOut = "signed-out"
}

private enum RegistryTask {
  @TaskLocal static var id: UUID?
}

public actor SemiontBrowser {
  public nonisolated let storage: any SessionStorage
  public nonisolated let knowledgeBases: Watched<[KnowledgeBase]>
  public nonisolated let activeKbId: Watched<String?>
  public nonisolated let activeSession = Watched<OpenedSession?>(nil)
  public nonisolated let activeSignals = Watched<SessionSignals?>(nil)
  public nonisolated let sessionActivating = Watched(false)
  public nonisolated let openResources = Watched<[OpenResource]>([])
  public nonisolated let lastViewedResource = Watched<ResourceId?>(nil)
  public nonisolated let identityToken = Watched<String?>(nil)
  public nonisolated let bus = EventBus()

  private nonisolated let failures = Broadcast<any Error>()
  private let factory: any SessionFactory
  private var tasks: [UUID: Task<Void, Never>] = [:]
  private var abandonable: Set<UUID> = []
  private var activation: UUID?
  private var sessionWatch: UUID?
  private var firstFailure: (any Error)?
  private var closed = false
  private var started = false

  init(_ config: SemiontBrowserConfig) throws {
    storage = config.storage
    factory = config.sessionFactory
    let stored = try loadKnowledgeBases(config.storage)
    knowledgeBases = Watched(stored)
    let active = try config.storage.get(activeKey)
    activeKbId = Watched(stored.first { $0.id == active }?.id ?? stored.first?.id)
  }

  deinit {
    for task in tasks.values { task.cancel() }
    activeSession.value?.dispose()
    activeSignals.value?.dispose()
    finish()
  }

  func start() throws {
    guard !started, !closed else { return }
    started = true
    try writeActive(activeKbId.value)
    for key in [knowledgeBasesKey, activeKey, openResourcesByKbKey, lastViewedResourceByKbKey] {
      watch(key)
    }
    try projectResources()
    activate()
  }

  public nonisolated func errors() -> Events<any Error> { failures.listen() }
  public nonisolated func setIdentityToken(_ value: String?) { identityToken.set(value) }

  private func requireOpen() throws {
    guard !closed else {
      throw BusRequestError(.busClosed, "The knowledge-base registry is closed")
    }
  }

  private func spawn(
    abandonOnClose: Bool = false, _ work: @escaping @Sendable () async -> Void
  ) -> UUID {
    let id = UUID()
    if abandonOnClose { abandonable.insert(id) }
    tasks[id] = Task { [weak self] in
      await RegistryTask.$id.withValue(id) { await work() }
      await self?.forget(id)
    }
    return id
  }

  private func forget(_ id: UUID) {
    abandonable.remove(id)
    tasks.removeValue(forKey: id)
  }

  @discardableResult
  private func watch(_ key: String) -> UUID? {
    guard let changes = storage.subscribe(key) else { return nil }
    return spawn { [weak self] in
      for await _ in changes {
        guard !Task.isCancelled else { break }
        await self?.storedChange(key)
      }
    }
  }

  private func storedChange(_ key: String) {
    guard !closed else { return }
    do {
      switch key {
      case knowledgeBasesKey:
        knowledgeBases.set(try loadKnowledgeBases(storage))
        if let id = activeKbId.value, !knowledgeBases.value.contains(where: { $0.id == id }) {
          try chooseActiveKb(knowledgeBases.value.first?.id)
        }
      case activeKey:
        let id = try storage.get(activeKey)
        if id != activeKbId.value {
          let bases = try loadKnowledgeBases(storage)
          knowledgeBases.set(bases)
          let valid = bases.first { $0.id == id }?.id
          activeKbId.set(valid)
          try projectResources()
          activate()
        }
      case openResourcesByKbKey, lastViewedResourceByKbKey: try projectResources()
      default:
        guard let id = activeKbId.value, key == sessionKey(id) else { return }
        let signedIn = try storedSession(storage, kbId: id) != nil
        if signedIn {
          if activeSession.value == nil, !sessionActivating.value { activate() }
        } else if activeSession.value != nil || sessionActivating.value {
          activate()
        }
      }
    } catch { record(error) }
  }

  private func record(_ error: any Error) {
    if firstFailure == nil { firstFailure = error }
    failures.yield(error)
  }

  private func writeActive(_ id: String?) throws {
    if let id { try storage.set(activeKey, id) } else { try storage.delete(activeKey) }
  }

  private func changeKnowledgeBases(
    _ change: @escaping @Sendable (inout [KnowledgeBase]) throws -> Void
  ) throws {
    try storage.update(knowledgeBasesKey) { text in
      var bases = readKnowledgeBases(text)
      try change(&bases)
      return try storedText(bases)
    }
    knowledgeBases.set(try loadKnowledgeBases(storage))
  }

  public func addKb(_ input: NewKnowledgeBase, session: HeldSignIn) async throws -> KnowledgeBase {
    try requireOpen()
    let kb = KnowledgeBase(
      did: input.did, endpoint: input.endpoint, id: UUID().uuidString, label: input.label,
      lastRead: input.lastRead)
    try storeSession(storage, kbId: kb.id, session: session)
    do {
      try changeKnowledgeBases { $0.append(kb) }
    } catch {
      try? clearStoredSession(storage, kbId: kb.id)
      throw error
    }
    try await setActiveKb(kb.id)
    return kb
  }

  public func removeKb(_ id: String) async throws {
    try requireOpen()
    try clearStoredSession(storage, kbId: id)
    try forgetResources(id)
    try changeKnowledgeBases { $0.removeAll { $0.id == id } }
    if activeKbId.value == id { try await setActiveKb(knowledgeBases.value.first?.id) }
  }

  public func updateKb(_ id: String, label: String? = nil, lastRead: KbRead? = nil) throws {
    try requireOpen()
    try changeKnowledgeBases { bases in
      guard let at = bases.firstIndex(where: { $0.id == id }) else { return }
      if let label { bases[at].label = label }
      if let lastRead { bases[at].lastRead = lastRead }
    }
  }

  public func kbSessionStatus(_ id: String) throws -> KbSessionStatus {
    guard let session = try storedSession(storage, kbId: id) else { return .signedOut }
    return isTokenExpired(session.access, now: Date().timeIntervalSince1970)
      ? .expired : .authenticated
  }

  public func setActiveKb(_ id: String?) async throws {
    try chooseActiveKb(id)
    try await waitForActivation()
  }

  private func chooseActiveKb(_ id: String?) throws {
    try requireOpen()
    guard id == nil || knowledgeBases.value.contains(where: { $0.id == id }) else {
      throw BusRequestError(.busNotFound, "The knowledge base is not registered")
    }
    if activeKbId.value == id, activeSession.value != nil || sessionActivating.value { return }
    try writeActive(id)
    activeKbId.set(id)
    try projectResources()
    activate()
  }

  public func signIn(_ id: String, session: HeldSignIn) async throws {
    try requireOpen()
    guard knowledgeBases.value.contains(where: { $0.id == id }) else {
      throw BusRequestError(.busNotFound, "The knowledge base is not registered")
    }
    try storeSession(storage, kbId: id, session: session)
    if activeKbId.value == id {
      activate()
    } else {
      try chooseActiveKb(id)
    }
    try await waitForActivation()
  }

  private func waitForActivation() async throws {
    let starting = activation
    guard starting != nil, starting != RegistryTask.id else { return }
    for await running in sessionActivating {
      if !running || activation != starting { break }
    }
    try Task.checkCancellation()
  }

  public func signOut(_ id: String) throws {
    try requireOpen()
    let old = try storedSession(storage, kbId: id)
    try clearStoredSession(storage, kbId: id)
    knowledgeBases.set(knowledgeBases.value)
    if activeKbId.value == id { activate() }
    if let old {
      let factory = factory
      _ = spawn(abandonOnClose: true) { await factory.revoke(old) }
    }
  }

  public func signedIn(_ signed: SignedIn) async throws -> SignInOutcome {
    try requireOpen()
    let did = try kbDid(signed.description.domain).value
    let result = Mutex<SignInOutcome?>(nil)
    let read = lastRead(signed.description)
    try changeKnowledgeBases { bases in
      let atAddress = bases.indices.filter { samePlace(bases[$0].endpoint, signed.endpoint) }
      let believed: KnowledgeBase?
      if let id = signed.kbId {
        believed = bases.first { $0.id == id }
      } else {
        believed = atAddress.count == 1 ? atAddress.first.map { bases[$0] } : nil
      }
      let expected =
        signed.expectedDid.map { Expected(did: $0, name: signed.expectedName) }
        ?? believed.map { Expected(did: $0.did, name: $0.label) }
      let kb: KnowledgeBase
      if let index = atAddress.first(where: { bases[$0].did == did }) {
        bases[index].label = signed.description.name
        bases[index].lastRead = read
        kb = bases[index]
      } else {
        kb = KnowledgeBase(
          did: did, endpoint: signed.endpoint, id: UUID().uuidString,
          label: signed.description.name, lastRead: read)
        bases.append(kb)
      }
      result.withLock { $0 = SignInOutcome(kb: kb, expected: expected) }
    }
    guard let outcome = result.withLock({ $0 }) else {
      throw BusRequestError(.busRejected, "Storage did not register the signed-in knowledge base")
    }
    try await signIn(outcome.kb.id, session: signed.session)
    return outcome
  }

  private func activate() {
    if let activation { tasks[activation]?.cancel() }
    if let sessionWatch { tasks[sessionWatch]?.cancel() }
    sessionWatch = nil
    activation = nil
    activeSession.value?.dispose()
    activeSignals.value?.dispose()
    activeSession.set(nil)
    activeSignals.set(nil)
    openResources.set([])
    lastViewedResource.set(nil)
    sessionActivating.set(false)

    guard !closed, let id = activeKbId.value,
      let kb = knowledgeBases.value.first(where: { $0.id == id })
    else { return }
    sessionWatch = watch(sessionKey(id))
    do {
      guard try storedSession(storage, kbId: id) != nil else { return }
    } catch {
      record(error)
      return
    }

    sessionActivating.set(true)
    let signals = SessionSignals()
    let options = SessionFactoryOptions(
      kb: kb, storage: storage, signals: signals,
      onError: { [weak self] error in
        Task { await self?.sessionFailed(error) }
      })
    let factory = factory
    let idOfTask = spawn(abandonOnClose: true) { [weak self] in
      do {
        let opened = try await factory.session(options)
        if !Task.isCancelled { _ = try? await opened.session.ready() }
        if let self {
          await self.install(opened, signals: signals)
        } else {
          opened.dispose()
          signals.dispose()
        }
      } catch {
        signals.dispose()
        await self?.activationFailed(error, id: id)
      }
    }
    activation = idOfTask
  }

  private func sessionFailed(_ error: any Error) {
    guard !closed else { return }
    record(error)
  }

  private func activationFailed(_ error: any Error, id: String) {
    guard !closed, activation == RegistryTask.id else { return }
    sessionActivating.set(false)
    record(SessionError(.sessionConstructFailed, String(describing: error), kbId: id))
  }

  private func install(_ opened: OpenedSession, signals: SessionSignals) async {
    guard !closed, !Task.isCancelled, activation == RegistryTask.id else {
      opened.dispose()
      signals.dispose()
      return
    }
    if let task = RegistryTask.id { abandonable.remove(task) }
    activeSession.set(opened)
    activeSignals.set(signals)
    sessionActivating.set(false)
    do {
      try projectResources()
      let read = try await readActiveKb()
      guard !closed, !Task.isCancelled, activeSession.value === opened else { return }
      if read.kind == .conflict, let observedDid = read.observedDid,
        let expected = knowledgeBases.value.first(where: { $0.id == opened.session.kb.id })?.did
      {
        try forgetResources(opened.session.kb.id)
        signals.notifyKbIdentityConflict(
          KbIdentityConflict(expectedDid: expected, observedDid: observedDid))
      } else {
        try await checkResources(opened)
      }
    } catch {
      if !Task.isCancelled { record(error) }
    }
  }

  public func readActiveKb() async throws -> KbReadVerdict {
    try requireOpen()
    guard let opened = activeSession.value,
      let kb = knowledgeBases.value.first(where: { $0.id == opened.session.kb.id })
    else { return KbReadVerdict(.noVerdict) }
    let description = try? await opened.client.browse.kb()
    guard !closed, !Task.isCancelled, activeSession.value === opened,
      let description, let did = try? kbDid(description.domain).value
    else { return KbReadVerdict(.noVerdict) }
    guard did == kb.did else {
      return KbReadVerdict(.conflict, observedDid: did, observedName: description.name)
    }
    try updateKb(kb.id, label: description.name, lastRead: lastRead(description))
    return KbReadVerdict(.recorded)
  }

  private var liveKbId: String? { activeSession.value?.session.kb.id }

  private func projectResources() throws {
    let open = decodedStorage([String: [OpenResource]].self, try storage.get(openResourcesByKbKey))
    let viewed = decodedStorage(
      [String: ResourceId].self, try storage.get(lastViewedResourceByKbKey))
    openResources.set(sortOpenResources(liveKbId.flatMap { open?[$0] } ?? []))
    lastViewedResource.set(liveKbId.flatMap { viewed?[$0] })
  }

  private func mutateResources(_ change: @escaping @Sendable (inout [OpenResource]) -> Void) throws
  {
    try requireOpen()
    guard let id = liveKbId else { return }
    try storage.update(openResourcesByKbKey) { text in
      var open = decodedStorage([String: [OpenResource]].self, text) ?? [:]
      change(&open[id, default: []])
      return try storedText(open)
    }
    try projectResources()
  }

  private func setLastViewed(_ resource: ResourceId?, kbId: String) throws {
    try storage.update(lastViewedResourceByKbKey) { text in
      var viewed = decodedStorage([String: ResourceId].self, text) ?? [:]
      viewed[kbId] = resource
      return try storedText(viewed)
    }
    try projectResources()
  }

  private func forgetResources(_ kbId: String) throws {
    try storage.update(openResourcesByKbKey) { text in
      var open = decodedStorage([String: [OpenResource]].self, text) ?? [:]
      open.removeValue(forKey: kbId)
      return try storedText(open)
    }
    try setLastViewed(nil, kbId: kbId)
  }

  public func addOpenResource(
    _ id: ResourceId, name: String, mediaType: String? = nil, storageUri: String? = nil
  ) throws {
    try mutateResources { open in
      if let index = open.firstIndex(where: { $0.id == id }) {
        open[index].name = name
        if let mediaType, !mediaType.isEmpty { open[index].mediaType = mediaType }
        if let storageUri, !storageUri.isEmpty { open[index].storageUri = storageUri }
        return
      }
      let now = Int64(Date().timeIntervalSince1970 * 1000)
      let lastOrder = max(-1, open.map(\.order).max() ?? -1)
      let order = lastOrder == Int.max ? lastOrder : lastOrder + 1
      open.append(
        OpenResource(
          id: id, name: name, openedAt: now, order: order, mediaType: mediaType,
          storageUri: storageUri))
    }
  }

  public func removeOpenResource(_ id: ResourceId) throws {
    try mutateResources { $0.removeAll { $0.id == id } }
  }

  public func updateOpenResourceName(_ id: ResourceId, name: String) throws {
    try mutateResources { open in
      if let index = open.firstIndex(where: { $0.id == id }) { open[index].name = name }
    }
  }

  public func reorderOpenResources(from: Int, to: Int) throws {
    try mutateResources { open in
      guard open.indices.contains(from), open.indices.contains(to) else { return }
      open = sortOpenResources(open)
      let resource = open.remove(at: from)
      open.insert(resource, at: to)
      for index in open.indices { open[index].order = index }
    }
  }

  public func setLastViewedResource(_ resource: ResourceId?) throws {
    try requireOpen()
    guard let id = liveKbId else { return }
    try setLastViewed(resource, kbId: id)
  }

  private func checkResources(_ opened: OpenedSession) async throws {
    let resources = openResources.value
    guard !resources.isEmpty else { return }
    let checks = await withTaskGroup(of: (ResourceId, TabCheck).self) { group in
      var pending = resources.makeIterator()
      var checks: [ResourceId: TabCheck] = [:]
      func startNext() {
        guard !Task.isCancelled, let resource = pending.next() else { return }
        group.addTask {
          (resource.id, await checkOpenResource(opened.client, id: resource.id))
        }
      }
      for _ in 0..<min(4, resources.count) { startNext() }
      for await (id, check) in group {
        checks[id] = check
        startNext()
      }
      return checks
    }
    guard !closed, !Task.isCancelled, activeSession.value === opened else { return }
    let incarnations = Dictionary(resources.map { ($0.id, $0.openedAt) }, uniquingKeysWith: max)
    try mutateResources { open in
      let current = open.filter { $0.openedAt == incarnations[$0.id] }.map(\.id)
      open = applyTabChecks(open, checks: checks.filter { current.contains($0.key) })
    }
  }

  private nonisolated func finish() {
    knowledgeBases.finish()
    activeKbId.finish()
    activeSession.finish(with: nil)
    activeSignals.finish(with: nil)
    sessionActivating.finish(with: false)
    openResources.finish()
    lastViewedResource.finish()
    identityToken.finish()
    failures.finish()
    bus.dispose()
  }

  public func close() async throws {
    if !closed {
      closed = true
      for (id, task) in tasks where id != RegistryTask.id { task.cancel() }
      activeSession.value?.dispose()
      activeSignals.value?.dispose()
      finish()
    }
    if RegistryTask.id == nil {
      for (id, task) in tasks where !abandonable.contains(id) { await task.value }
    }
    if let firstFailure { throw firstFailure }
  }
}

private func samePlace(_ lhs: KbEndpoint, _ rhs: KbEndpoint) -> Bool {
  switch (lhs, rhs) {
  case (.httpEndpoint(let a), .httpEndpoint(let b)): return a.host == b.host && a.port == b.port
  case (.localEndpoint(let a), .localEndpoint(let b)): return a.kbId == b.kbId
  default: return false
  }
}

private func lastRead(_ description: KbDescription) -> KbRead {
  KbRead(
    at: Date().formatted(.iso8601.time(includingFractionalSeconds: true)),
    gitBranch: description.gitBranch)
}

public func newSemiontBrowser(_ config: SemiontBrowserConfig) async throws -> SemiontBrowser {
  let browser = try SemiontBrowser(config)
  try await browser.start()
  return browser
}

public func beginSignIn(
  _ browser: SemiontBrowser, options: BeginAuthorizationOptions, httpClient: HTTPClient
) async throws -> String {
  try await beginAuthorization(options, storage: browser.storage, httpClient: httpClient)
}

public func completeSignIn(
  _ browser: SemiontBrowser, callback: String, httpClient: HTTPClient
) async throws -> SignInOutcome {
  let (pending, session) = try await completeAuthorization(
    callback, storage: browser.storage, httpClient: httpClient)
  let identity = try await describeConnection(
    pending.target, access: session.access, httpClient: httpClient)
  return try await browser.signedIn(
    SignedIn(
      endpoint: .httpEndpoint(pending.target), description: identity.description, session: session,
      kbId: pending.kbId, expectedDid: pending.expectedDid, expectedName: pending.expectedName))
}
