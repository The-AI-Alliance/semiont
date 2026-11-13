import AsyncHTTPClient
import Foundation
import Synchronization

public struct SemiontBrowserConfig: Sendable {
  public let storage: any SessionStorage
  public let sessionFactory: any SessionFactory
  let clock: any Clock<Duration>
  let random: RandomSource

  public init(
    storage: any SessionStorage, sessionFactory: any SessionFactory,
    clock: any Clock<Duration> = ContinuousClock(),
    random: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator()
  ) {
    self.storage = storage
    self.sessionFactory = sessionFactory
    self.clock = clock
    self.random = RandomSource(random)
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

  private nonisolated let failures = Broadcast<SessionError>(keepingForFirst: true)
  nonisolated let clock: any Clock<Duration>
  nonisolated let random: RandomSource
  private let factory: any SessionFactory
  private var tasks: [UUID: Task<Void, Never>] = [:]
  private var abandonable: Set<UUID> = []
  private var activation: UUID?
  private var sessionWatch: UUID?
  /// The first failure of the work it ran, which its close raises; nothing it said is one.
  private var taskFailure: (any Error)?
  /// The task reading each session's errors, by the session's id, while it reads them.
  private var readers: [String: UUID] = [:]
  /// The end of every session it has let go of, after those it let go of before: each with its
  /// client closed and its errors read to their end, so what its closing flush met is said by then.
  /// Neither an activation nor its close goes on until then; a renewal of a sign-in under way is
  /// not waited for.
  private var sessionsEnded: Task<Void, Never>?
  /// The end of every activation it has given up, after those it gave up before: each once it has
  /// let go of what it built. An activation asks for no session until then; its close does not wait
  /// for it.
  private var activationsGivenUp: Task<Void, Never>?
  private var errorsEnded = false
  private var closed = false
  private var started = false
  /// The knowledge bases whose replaced or cleared sign-in's person is being forgotten: none gets a
  /// session until that is done.
  private var forgetting: Set<String> = []

  init(_ config: SemiontBrowserConfig) throws {
    storage = config.storage
    clock = config.clock
    random = config.random
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
    finishShown()
    failures.finish()
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

  /// What went wrong: each of its sessions' own errors, and each refusal of a session by its
  /// factory. What its own work fails with is not said on them: its close raises that. The first
  /// listener is given first the latest `Timings.errorsKeptForFirstReaderCount` said before it
  /// listened; one who comes after they have ended, nothing.
  public nonisolated func errors() -> Events<SessionError> { failures.listen() }
  public nonisolated func setIdentityToken(_ value: String?) { identityToken.set(value) }

  private func requireOpen() throws {
    guard !closed else {
      throw BusRequestError(.busClosed, "The knowledge-base registry is closed")
    }
  }

  /// Starts `work` as one of the registry's tasks, kept until it ends; the id names it.
  private func registryTask(
    abandonOnClose: Bool = false, _ work: @escaping @Sendable () async -> Void
  ) -> UUID {
    let id = UUID()
    if abandonOnClose { abandonable.insert(id) }
    tasks[id] = spawn { [weak self] in
      await RegistryTask.$id.withValue(id) { await work() }
      await self?.forget(id)
    }
    return id
  }

  private func forget(_ id: UUID) {
    abandonable.remove(id)
    tasks.removeValue(forKey: id)
    readers = readers.filter { $0.value != id }
  }

  @discardableResult
  private func watch(_ key: String) -> UUID? {
    guard let changes = storage.subscribe(key) else { return nil }
    return registryTask { [weak self] in
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
    } catch { failedAtWork(error) }
  }

  /// Keeps `error`, what its own work failed with, for its close to raise, when it is the first.
  private func failedAtWork(_ error: any Error) {
    if taskFailure == nil { taskFailure = error }
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
    let old = try swapStoredSession(storage, kbId: id, with: nil)
    try forgetResources(id)
    try changeKnowledgeBases { $0.removeAll { $0.id == id } }
    let active = activeKbId.value == id
    try await forgetAfterClosing(old, kbId: id)
    if active {
      try chooseActiveKb(knowledgeBases.value.first?.id)
      try await waitForActivation()
    }
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
    let old = try swapStoredSession(storage, kbId: id, with: session)
    try await forgetAfterClosing(old, kbId: id)
    if activeKbId.value == id {
      activate()
    } else {
      try chooseActiveKb(id)
    }
    try await waitForActivation()
  }

  /// Forgets what was kept on the knowledge base `kbId` for the person `old`, the saved sign-in it
  /// just replaced or cleared, named: once kbId's session, when it is the active one, has closed,
  /// its client and then itself, so that nothing it was writing, or writes as it closes, is left.
  private func forgetAfterClosing(_ old: HeldSignIn?, kbId: String) async throws {
    forgetting.insert(kbId)
    defer { forgetting.remove(kbId) }
    if activeKbId.value == kbId { await deactivate()?.closed() }
    try forgetKept(storage, kbId: kbId, of: old)
  }

  private func waitForActivation() async throws {
    let starting = activation
    guard starting != nil, starting != RegistryTask.id else { return }
    for await running in sessionActivating {
      if !running || activation != starting { break }
    }
    try Task.checkCancellation()
  }

  public func signOut(_ id: String) async throws {
    try requireOpen()
    let old = try swapStoredSession(storage, kbId: id, with: nil)
    knowledgeBases.set(knowledgeBases.value)
    if let old {
      let factory = factory
      _ = registryTask(abandonOnClose: true) { await factory.revoke(old) }
    }
    try await forgetAfterClosing(old, kbId: id)
    if activeKbId.value == id { activate() }
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

  /// Closes the active knowledge base's session, and gives it; and gives up the activation under
  /// way. The session joins its ``sessionsEnded``, and the activation its ``activationsGivenUp``.
  @discardableResult
  private func deactivate() -> OpenedSession? {
    if let activation, let givenUp = tasks[activation] {
      givenUp.cancel()
      let before = activationsGivenUp
      activationsGivenUp = spawn {
        await before?.value
        await givenUp.value
      }
    }
    if let sessionWatch { tasks[sessionWatch]?.cancel() }
    sessionWatch = nil
    activation = nil
    let closing = activeSession.value
    if let closing { letGo(closing) }
    activeSignals.value?.dispose()
    activeSession.set(nil)
    activeSignals.set(nil)
    openResources.set([])
    lastViewedResource.set(nil)
    sessionActivating.set(false)
    return closing
  }

  private func activate() {
    deactivate()
    guard !closed, let id = activeKbId.value, !forgetting.contains(id),
      let kb = knowledgeBases.value.first(where: { $0.id == id })
    else { return }
    sessionWatch = watch(sessionKey(id))
    do {
      guard try storedSession(storage, kbId: id) != nil else { return }
    } catch {
      failedAtWork(error)
      return
    }

    sessionActivating.set(true)
    let signals = SessionSignals()
    let options = SessionFactoryOptions(kb: kb, storage: storage, signals: signals)
    let factory = factory
    let givenUp = activationsGivenUp
    let idOfTask = registryTask(abandonOnClose: true) { [weak self] in
      await givenUp?.value
      let ended = await self?.sessionsEnded
      await ended?.value
      guard !Task.isCancelled else {
        signals.dispose()
        return
      }
      do {
        let opened = try await factory.session(options)
        await self?.read(opened.session, signals: signals)
        if !Task.isCancelled { await opened.session.ready() }
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

  /// Reads `session`'s errors as their one reader, and so from the first thing it said, until they
  /// end: each of its own it says on the registry's errors. A refusal for lack of permission has no
  /// remedy, and is said through `signals`; any other failure of its transport, a refusal for want
  /// of a valid token among them, is not acted on.
  private func read(_ session: SemiontSession, signals: SessionSignals) {
    let errors = session.errors()
    readers[session.id] = registryTask { [weak self] in
      do {
        for try await error in errors {
          if let own = error as? SessionError {
            await self?.said(own)
            continue
          }
          if let failure = error as? TransportError, failure.reason == .forbidden {
            signals.notifyPermissionDenied(failure.description)
          }
        }
      } catch {
        preconditionFailure("A session's errors end without failing: \(error)")
      }
    }
  }

  /// Says `error` on the registry's errors until they end.
  private func said(_ error: SessionError) {
    guard !errorsEnded else { return }
    failures.yield(error)
  }

  /// Says what its factory refused the session of `id` with: one of the session's own errors as it
  /// is, and any other failure as `session.construct-failed`, with what that failure says.
  private func activationFailed(_ error: any Error, id: String) {
    guard !closed, activation == RegistryTask.id else { return }
    sessionActivating.set(false)
    if let own = error as? SessionError {
      said(own)
    } else {
      said(SessionError(.sessionConstructFailed, String(describing: error), kbId: id))
    }
  }

  /// Closes `opened`, its client first, and joins its end to ``sessionsEnded``: once its client
  /// has closed and its errors have been read to their end.
  private func letGo(_ opened: OpenedSession) {
    let reader = readers[opened.session.id].flatMap { tasks[$0] }
    opened.dispose()
    let before = sessionsEnded
    sessionsEnded = spawn {
      await before?.value
      await opened.client.closed()
      await reader?.value
    }
  }

  private func install(_ opened: OpenedSession, signals: SessionSignals) async {
    guard !closed, !Task.isCancelled, activation == RegistryTask.id else {
      letGo(opened)
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
      if !Task.isCancelled { failedAtWork(error) }
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
      for _ in 0..<min(Timings.checksAtOnceCount, resources.count) { startNext() }
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

  /// Ends what it shows, and its bus: all but its errors.
  private nonisolated func finishShown() {
    knowledgeBases.finish()
    activeKbId.finish()
    activeSession.finish(with: nil)
    activeSignals.finish(with: nil)
    sessionActivating.finish(with: false)
    openResources.finish()
    lastViewedResource.finish()
    identityToken.finish()
    bus.dispose()
  }

  /// Ends its errors, and stops reading every session's still read.
  private func endErrors() {
    errorsEnded = true
    failures.finish()
    for id in readers.values { tasks[id]?.cancel() }
  }

  /// Ends its live session, its client first, and waits for every session it has let go of, that
  /// one among them, to end before it ends its errors: each once its client has closed and its
  /// errors have been read to their end, so what each closing flush meets is said on them. An
  /// activation under way is given up and not waited for: a session its factory hands back
  /// afterwards is ended at once. It raises the first failure of the work it ran, and nothing it
  /// said. Closing twice is closing once: the second returns at once.
  public func close() async throws {
    guard !closed else { return }
    closed = true
    let reading = Set(readers.values)
    for (id, task) in tasks where id != RegistryTask.id && !reading.contains(id) { task.cancel() }
    let live = activeSession.value
    if let live { letGo(live) }
    activeSignals.value?.dispose()
    finishShown()
    let ended = sessionsEnded
    if RegistryTask.id == nil {
      for (id, task) in tasks where !abandonable.contains(id) && !readers.values.contains(id) {
        await task.value
      }
    }
    await ended?.value
    await live?.closed()
    endErrors()
    if let taskFailure { throw taskFailure }
  }
}

/// Whether two endpoints are one place: for a gateway, its origin (the protocol, the host in
/// lowercase and the port); for a loaded knowledge base, its id.
func samePlace(_ lhs: KbEndpoint, _ rhs: KbEndpoint) -> Bool {
  switch (lhs, rhs) {
  case (.httpEndpoint(let a), .httpEndpoint(let b)):
    return a.protocol == b.protocol && a.host.lowercased() == b.host.lowercased()
      && a.port == b.port
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
  try await beginAuthorization(
    options, storage: browser.storage, httpClient: httpClient, clock: browser.clock)
}

public func completeSignIn(
  _ browser: SemiontBrowser, callback: String, httpClient: HTTPClient
) async throws -> SignInOutcome {
  let (pending, session) = try await completeAuthorization(
    callback, storage: browser.storage, httpClient: httpClient, clock: browser.clock)
  let identity = try await describeConnection(
    pending.target, access: session.access, httpClient: httpClient, clock: browser.clock,
    random: browser.random)
  return try await browser.signedIn(
    SignedIn(
      endpoint: .httpEndpoint(pending.target), description: identity.description, session: session,
      kbId: pending.kbId, expectedDid: pending.expectedDid, expectedName: pending.expectedName))
}
