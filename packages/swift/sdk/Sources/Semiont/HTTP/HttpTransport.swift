import AsyncHTTPClient
import Foundation
import OpenTelemetryApi

public actor HttpTransport: Transport, GatewayOperations {
  public nonisolated let baseUrl: String
  public nonisolated let state = Watched<ConnectionState>(.initial)
  nonisolated let lifetime = Lifetime()
  nonisolated let failureEvents = Broadcast<TransportError>()
  let http: HTTPClient
  let timing: TransportTiming
  nonisolated let clock: any Clock<Duration>
  nonisolated let random: RandomSource
  let channels: [String]
  let clientID = UUID().uuidString
  var token: String?
  let refresher: (@Sendable (String?) async throws -> String?)?
  var renewal: (UUID, Task<String?, Error>)?
  var listeners: [UUID: (channels: Set<String>, hub: Broadcast<Carried>)] = [:]
  var holds: [ResourceId: Int] = [:]
  var watermarks: [ResourceId: String] = [:]
  var seen: SeenEventIDs
  struct Connection: Sendable {
    let task: UUID
    let token: String
    let previous: Set<UUID>
  }
  var connections: [UUID: Connection] = [:]
  var live: UUID?
  var connecting: UUID?
  var reconnectOwed = false
  var superseded: Set<UUID> = []
  var refusedToken: String?
  var askedRefresh = false
  var failuresInARow = 0
  var retry: UUID?
  var changed: UUID?
  var removed: UUID?
  var degraded: UUID?
  var started = false
  struct Pending {
    let result: String
    let failure: String
    let cancel: @Sendable () -> Void
    let complete: @Sendable (Result<ReceivedFrame, any Error>) -> Void
  }
  var pending: [String: Pending] = [:]
  var sentCounter: (any LongCounter)?
  var emitTail: Task<Void, Never>?

  public init(
    baseUrl: String, httpClient: HTTPClient, token: String?, channels: [String]? = nil,
    timing: TransportTiming = TransportTiming(), clock: any Clock<Duration> = ContinuousClock(),
    random: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator(),
    refresher: (@Sendable (String?) async throws -> String?)? = nil
  ) {
    self.baseUrl = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
    self.http = httpClient
    self.token = token
    self.channels = channels ?? bridgedChannels
    self.timing = timing
    self.clock = clock
    self.random = RandomSource(random)
    self.refresher = refresher
    self.seen = SeenEventIDs(capacity: timing.seenEventIdsCount)
    let state = self.state
    let failures = failureEvents
    lifetime.onEnd {
      state.finish(with: .closed)
      failures.finish()
    }
    Task { [weak self] in await self?.start() }
  }
  deinit { lifetime.end() }
  public nonisolated func dispose() { lifetime.end() }
  public nonisolated func failures() -> Events<TransportError> { failureEvents.listen() }

  public func frames(_ channels: [String]) throws -> Events<Carried> {
    for channel in channels
    where !self.channels.contains(channel) && !busAudience.scoped.contains(channel) {
      throw unsubscribed(channel)
    }
    let id = UUID()
    let hub = Broadcast<Carried>()
    let lifetime = self.lifetime
    listeners[id] = (Set(channels), hub)
    lifetime.onEnd(id: id) { hub.finish() }
    return hub.listen { [weak self] in
      lifetime.forgetEnding(id)
      Task { await self?.removeListener(id) }
    }
  }
  func restoreBookmarks(_ bookmarks: [ResourceId: String]) {
    watermarks.merge(bookmarks) { current, _ in current }
  }

  func removeListener(_ id: UUID) { listeners.removeValue(forKey: id) }
  public func isSubscribed(_ channel: String) -> Bool { channels.contains(channel) }
  public func setToken(_ token: String?) {
    let previous = self.token
    self.token = token
    if token != previous, refusedToken != token, live == nil {
      cancel(retry)
      retry = nil
      connect(keepingPrevious: false)
    }
  }
  func start() {
    guard !started, !lifetime.ended else { return }
    started = true
    lifetime.onEnd { [weak self] in Task { await self?.stopped() } }
    connect(keepingPrevious: false)
  }
  func stopped() {
    for waiter in pending.values {
      waiter.cancel()
      waiter.complete(.failure(BusRequestError(.busClosed, "The transport closed")))
    }
    pending.removeAll()
    connections.removeAll()
  }
  func spawn(
    after milliseconds: Int = 0, _ action: @escaping @Sendable (HttpTransport) async -> Void
  ) -> UUID {
    let id = UUID()
    let lifetime = self.lifetime
    let clock = self.clock
    let task = Task { [weak self] in
      defer { lifetime.forget(id) }
      do { try await sleepMilliseconds(milliseconds, on: clock) } catch { return }
      guard !lifetime.ended, let self else { return }
      await action(self)
    }
    lifetime.keep(task, id: id)
    return id
  }
  func cancel(_ id: UUID?) { if let id { lifetime.cancel(id) } }
  func transition(_ next: ConnectionState) {
    guard !lifetime.ended, state.value != next, state.value.mayBecome(next) else { return }
    state.set(next)
    cancel(degraded)
    degraded = nil
    if next == .reconnecting {
      degraded = spawn(after: Timings.degradedThresholdMs) { owner in await owner.markDegraded() }
    }
  }
  func markDegraded() { if state.value == .reconnecting { transition(.degraded) } }

  public func subscribeToResource(_ resource: ResourceId) -> ResourceHold {
    let count = holds[resource, default: 0]
    holds[resource] = count + 1
    if count == 0 {
      cancel(removed)
      removed = nil
      cancel(changed)
      changed = spawn(after: Timings.reconnectDebounceMs) { owner in
        await owner.subscriptionChanged()
      }
    }
    return ResourceHold { [weak self] in Task { await self?.release(resource) } }
  }
  func release(_ resource: ResourceId) {
    guard let count = holds[resource] else { return }
    if count > 1 {
      holds[resource] = count - 1
      return
    }
    holds.removeValue(forKey: resource)
    if changed == nil, removed == nil {
      removed = spawn(after: timing.lazyRemoveMs) { owner in await owner.subscriptionChanged() }
    }
  }
  func subscriptionChanged() {
    changed = nil
    removed = nil
    reconnect()
  }
  func reconnect() {
    guard !lifetime.ended else { return }
    if connecting != nil {
      reconnectOwed = true
      return
    }
    cancel(retry)
    retry = nil
    connect(keepingPrevious: true)
  }
  func connect(keepingPrevious: Bool) {
    guard !lifetime.ended, !channels.isEmpty || !holds.isEmpty else { return }
    guard let token, !token.isEmpty, token != refusedToken else {
      if live == nil { transition(.unauthenticated) }
      return
    }
    refusedToken = nil
    let previous = Set(connections.keys)
    if !keepingPrevious {
      for connection in previous { retire(connection) }
      live = nil
    }
    if live == nil { transition(.connecting) }
    let scoped = holds.keys.sorted { $0.value < $1.value }.map { resource in
      BusSubscribeRequestScopedItem(
        channels: busAudience.scoped, lastEventId: watermarks[resource], scope: resource)
    }
    let body = BusSubscribeRequest(
      clientId: clientID, global: channels, pendingReplies: pending.keys.sorted(), scoped: scoped)
    let id = UUID()
    let http = self.http
    let base = baseUrl
    let deadline = timing.streamOpenMs
    let bodyDeadline = timing.httpRequestMs
    let clock = self.clock
    let life = lifetime
    let task = Task { [weak self] in
      defer { life.forget(id) }
      do {
        var request = HTTPClientRequest(url: base + "/bus/subscribe")
        request.method = .POST
        request.headers.add(name: "Authorization", value: "Bearer " + token)
        request.headers.add(name: "Content-Type", value: "application/json")
        request.headers.add(name: "Accept", value: "text/event-stream")
        request.body = .bytes(try JSONEncoder().encode(body))
        let response = try await within(.milliseconds(deadline), on: clock) { [request] in
          try await http.execute(request, deadline: .distantFuture)
        }
        if !(200..<300).contains(Int(response.status.code)) {
          let failure = await Self.refusal(
            response, path: "/bus/subscribe", deadlineMs: bodyDeadline, clock: clock)
          await self?.connectionRefused(id, error: failure)
          return
        }
        await self?.opened(id)
        var parser = SSEParser()
        for try await bytes in response.body {
          try Task.checkCancellation()
          for event in parser.feed(bytes.readableBytesView)
          where event.event == "bus-event" && !event.data.isEmpty {
            await self?.received(event, connection: id)
          }
        }
      } catch {}
      await self?.ended(id)
    }
    connections[id] = Connection(task: id, token: token, previous: keepingPrevious ? previous : [])
    connecting = id
    life.keep(task, id: id)
  }
  func opened(_ id: UUID) {
    guard let connection = connections[id], !lifetime.ended else { return }
    superseded.formUnion(connection.previous)
    for old in connection.previous {
      _ = spawn(after: timing.lingerMs) { owner in await owner.retire(old) }
    }
    live = id
    failuresInARow = 0
    askedRefresh = false
    transition(.open)
    settled(id, opened: true)
  }
  func settled(_ id: UUID, opened: Bool) {
    guard connecting == id else { return }
    connecting = nil
    let owed = reconnectOwed
    reconnectOwed = false
    if opened && owed { reconnect() }
  }
  func retire(_ id: UUID) {
    guard let connection = connections.removeValue(forKey: id) else { return }
    cancel(connection.task)
    superseded.remove(id)
  }
  func received(_ event: SSEEvent, connection: UUID) {
    guard connections[connection] != nil, !lifetime.ended else { return }
    if let id = event.id, !seen.remember(id) { return }
    switch lineOf(event.data) {
    case .allowed(let wire): deliver(wire, id: event.id)
    case .refused(let refusal): refuse(refusal)
    case .unaddressed(let fault):
      failureEvents.yield(
        TransportError(.error, "the stream carried what is not a frame: \(fault.said)"))
    }
  }
  /// Tell a refused frame to the request awaiting the reply it names, on its channel, which fails
  /// with it, and to its channel's readers. Its id is remembered, and it moves no watermark.
  private func refuse(_ refusal: FrameRefusal) {
    if let correlation = refusal.correlationId, let waiter = pending[correlation],
      refusal.channel == waiter.result || refusal.channel == waiter.failure
    {
      fail(correlation, error: TransportError(.error, notTheFrames(refusal)))
    }
    told(.refused(refusal))
  }
  private func told(_ carried: Carried) {
    for listener in listeners.values
    where listener.channels.isEmpty || listener.channels.contains(carried.channel) {
      listener.hub.yield(carried)
    }
  }
  private func deliver(_ allowed: BusFrame, id eventId: String?) {
    var wire = allowed
    var payload = wire.payload
    let trace: [String: String]?
    if case .object(let fields) = payload.removeValue(forKey: traceField) {
      trace = fields.reduce(into: [:]) { result, pair in
        if case .string(let text) = pair.value { result[pair.key] = text }
      }
    } else {
      trace = nil
    }
    let received = transportSpan(
      .busRecvChannel, channel: wire.channel, scope: wire.scope, parent: trace)
    defer { received.end() }
    wire.payload = payload
    let frame = ReceivedFrame(wire, trace: trace, eventId: eventId)
    if let id = eventId, id.hasPrefix("p-"), let scope = frame.scope { watermarks[scope] = id }
    BusLog.line(
      "RECV", channel: frame.channel, payload: frame.payload, scope: frame.scope,
      correlationID: frame.correlationId, traceID: received.context.traceId.hexString)
    if let correlation = frame.correlationId, let waiter = pending[correlation],
      frame.channel == waiter.result || frame.channel == waiter.failure
    {
      pending.removeValue(forKey: correlation)
      waiter.cancel()
      waiter.complete(.success(frame))
    }
    told(.frame(frame))
  }
  func connectionRefused(_ id: UUID, error: TransportError) {
    guard let connection = connections.removeValue(forKey: id), !lifetime.ended else { return }
    settled(id, opened: false)
    failureEvents.yield(error)
    let retired = superseded.remove(id) != nil
    if error.reason == .unauthorized, !retired {
      refusedToken = connection.token
      failuresInARow = 0
      if live == nil { transition(.unauthenticated) }
      if refresher != nil, !askedRefresh {
        askedRefresh = true
        _ = spawn { owner in
          _ = try? await owner.renew(refused: connection.token)
          await owner.reconnect()
        }
      }
      return
    }
    dropped(id, retired: retired, floor: error.retryAfterMs ?? 0)
  }
  func ended(_ id: UUID) {
    guard connections.removeValue(forKey: id) != nil else { return }
    settled(id, opened: false)
    dropped(id, retired: superseded.remove(id) != nil, floor: 0)
  }
  func dropped(_ id: UUID, retired: Bool, floor: Int) {
    guard !lifetime.ended, !retired else { return }
    let keepPrevious = live != nil && live != id
    if !keepPrevious {
      live = nil
      transition(.reconnecting)
      if connecting != nil {
        transition(.connecting)
        return
      }
    }
    var cap = timing.reconnectMs
    for _ in 0..<min(failuresInARow, 20) { cap = min(cap * 2, Timings.maxReconnectMs) }
    failuresInARow += 1
    cancel(retry)
    retry = spawn(after: max(equalJitter(cap, from: random), floor)) { owner in
      await owner.retryConnect(keepingPrevious: keepPrevious)
    }
  }
  func retryConnect(keepingPrevious: Bool) {
    retry = nil
    connect(keepingPrevious: keepingPrevious)
  }
  func renew(refused: String?) async throws -> String? {
    if token != refused, let token, !token.isEmpty { return token }
    if let renewal { return try await sharedValue(renewal.1, lifetime: lifetime) }
    guard let refresher else { return nil }
    let id = UUID()
    let task = Task { [weak self] in
      do {
        let result = try await refresher(refused)
        await self?.renewed(id, token: result)
        return result
      } catch {
        await self?.renewed(id, token: nil)
        throw error
      }
    }
    renewal = (id, task)
    lifetime.keep(task, id: id)
    return try await sharedValue(task, lifetime: lifetime)
  }
  func renewed(_ id: UUID, token: String?) {
    lifetime.forget(id)
    guard renewal?.0 == id else { return }
    renewal = nil
    if !lifetime.ended, let token { self.token = token }
  }
}

/// What a `bus-event` line carried, read as a frame.
private enum Line: Sendable {
  /// A frame BusFrame allows.
  case allowed(BusFrame)
  /// A frame BusFrame does not allow that names its readers, whose refusal is told to them in its
  /// place.
  case refused(FrameRefusal)
  /// What names no reader, told to the failure report by its first fault.
  case unaddressed(Fault)
}

/// `data` read as a frame, held to BusFrame by the table: a frame carries what BusFrame names, and
/// nothing more. A frame BusFrame does not allow names its readers when its `channel` is a text of
/// at least one character and it carries no `scope` or one that is a resource's id, whatever its
/// first fault.
private func lineOf(_ data: String) -> Line {
  let bytes = Data(data.utf8)
  guard let value = try? JSONDecoder().decode(JSONValue.self, from: bytes) else {
    return .unaddressed(.undecoded)
  }
  let fault: Fault
  if let found = faultOf("BusFrame", value) {
    fault = found
  } else {
    do { return .allowed(try JSONDecoder().decode(BusFrame.self, from: bytes)) } catch {
      fault = .undecoded
    }
  }
  guard case .object(let stated) = value, case .string(let channel)? = stated["channel"],
    !channel.isEmpty
  else { return .unaddressed(fault) }
  // A null where a member may be absent is its absence, as BusFrame reads it.
  let scope: ResourceId?
  switch stated["scope"] {
  case nil, .null?: scope = nil
  case .string(let text)?:
    guard let resource = ResourceId.parse(text) else { return .unaddressed(fault) }
    scope = resource
  case .some: return .unaddressed(fault)
  }
  return .refused(
    FrameRefusal(
      channel: channel, member: fault.member, reason: fault.reason, payload: stated["payload"],
      correlationId: correlationIdOf(channel, stated["correlationId"]), scope: scope))
}

/// The correlation id a frame on `channel` carries as `held`, when BusFrame allows it, whatever the
/// frame's other faults.
private func correlationIdOf(_ channel: String, _ held: JSONValue?) -> String? {
  guard case .string(let text)? = held else { return nil }
  let alone = JSONValue.object([
    "channel": .string(channel), "payload": .object([:]), "correlationId": .string(text),
  ])
  return faultOf("BusFrame", alone) == nil ? text : nil
}
