import AsyncHTTPClient
import Foundation
import OpenTelemetryApi

public actor HttpTransport {
  public nonisolated let baseUrl: String
  public nonisolated let state = Watched<ConnectionState>(.initial)
  nonisolated let lifetime = Lifetime()
  nonisolated let failureEvents = Broadcast<TransportError>()
  let http: HTTPClient
  let timing: TransportTiming
  let channels: [String]
  let clientID = UUID().uuidString
  var token: String?
  let refresher: (@Sendable (String?) async throws -> String?)?
  var renewal: (UUID, Task<String?, Error>)?
  var listeners: [UUID: (channels: Set<String>, hub: Broadcast<ReceivedFrame>)] = [:]
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
    timing: TransportTiming = TransportTiming(),
    refresher: (@Sendable (String?) async throws -> String?)? = nil
  ) {
    self.baseUrl = baseUrl.hasSuffix("/") ? String(baseUrl.dropLast()) : baseUrl
    self.http = httpClient
    self.token = token
    self.channels = channels ?? bridgedChannels
    self.timing = timing
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

  public func frames(_ channels: String...) throws -> Events<ReceivedFrame> {
    for channel in channels
    where !self.channels.contains(channel) && !busAudience.scoped.contains(channel) {
      throw BusRequestError(.busUnsubscribed, "Transport is not subscribed to \(channel)")
    }
    let id = UUID()
    let hub = Broadcast<ReceivedFrame>()
    let lifetime = self.lifetime
    listeners[id] = (Set(channels), hub)
    lifetime.onEnd(id: id) { hub.finish() }
    return hub.listen { [weak self] in
      lifetime.forgetEnding(id)
      Task { await self?.removeListener(id) }
    }
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
    let task = Task { [weak self] in
      defer { lifetime.forget(id) }
      do { try await sleepMilliseconds(milliseconds) } catch { return }
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
        let response = try await within(deadline) { [request] in
          try await http.execute(request, deadline: .distantFuture)
        }
        if !(200..<300).contains(Int(response.status.code)) {
          let failure = await Self.refusal(
            response, path: "/bus/subscribe", deadlineMs: bodyDeadline)
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
    guard let data = event.data.data(using: .utf8),
      var wire = try? JSONDecoder().decode(BusFrame.self, from: data)
    else { return }
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
    let frame = ReceivedFrame(wire, trace: trace)
    if let id = event.id, id.hasPrefix("p-"), let scope = frame.scope { watermarks[scope] = id }
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
    for listener in listeners.values where listener.channels.contains(frame.channel) {
      listener.hub.yield(frame)
    }
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
    retry = spawn(after: max(equalJitter(cap), floor)) { owner in
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
