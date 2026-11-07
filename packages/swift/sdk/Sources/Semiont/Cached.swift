import Foundation

public enum CacheState<Value: Sendable>: Sendable {
  case pending
  case ready(Value)
  case failed(any Error)
}

extension CacheState {
  func map<Seen: Sendable>(_ see: (Value) -> Seen) -> CacheState<Seen> {
    switch self {
    case .pending: .pending
    case .ready(let value): .ready(see(value))
    case .failed(let error): .failed(error)
    }
  }
}

/// A read-through query. Iteration watches its shared state and fresh() asks for a current answer.
public final class Cached<Value: Sendable>: AsyncSequence, Sendable {
  public typealias Element = CacheState<Value>
  private let reading: Reading
  private let held: CacheEntry<Value>?

  init(
    lifetime: Lifetime, hold: (@Sendable () async -> ResourceHold)? = nil,
    kept: KeptValue<Value>? = nil, owed: Unsettled?,
    invalidationWindowMs: Int = Timings.invalidationWindowMs, clock: any Clock<Duration>,
    fetch: @escaping @Sendable () async throws -> Value
  ) {
    let entry = CacheEntry(
      lifetime: lifetime, hold: hold, kept: kept, owed: owed,
      invalidationWindowMs: invalidationWindowMs, clock: clock, fetch: fetch)
    held = entry
    reading = Reading(entry) { $0 }
    lifetime.onEnd { [weak entry] in
      Task { await entry?.close() }
    }
  }

  private init(reading: Reading) {
    self.reading = reading
    held = nil
  }

  /// This query as `see` sees its value: the same states, answers and observers, shown otherwise.
  func view<Seen: Sendable>(_ see: @escaping @Sendable (Value) -> Seen) -> Cached<Seen> {
    Cached<Seen>(reading: Cached<Seen>.Reading(entry, see))
  }

  /// A query's entry, as one query shows its value.
  fileprivate struct Reading: Sendable {
    let ended: @Sendable () -> Bool
    let observe: @Sendable () async -> (AsyncStream<Element>, ResourceHold)?
    let fresh: @Sendable () async throws -> Value
    let invalidate: @Sendable () async -> Void

    init<Held: Sendable>(_ entry: CacheEntry<Held>, _ see: @escaping @Sendable (Held) -> Value) {
      ended = { entry.ended }
      observe = { await entry.observe(seeing: see) }
      fresh = { see(try await entry.fresh()) }
      invalidate = { await entry.invalidate() }
    }
  }

  public struct AsyncIterator: AsyncIteratorProtocol {
    private let reading: Reading
    private var reader: AsyncStream<Element>.Iterator?
    private var subscription: ResourceHold?

    fileprivate init(reading: Reading) { self.reading = reading }

    public mutating func next() async -> Element? {
      guard !reading.ended(), !Task.isCancelled else {
        subscription?.dispose()
        return nil
      }
      if reader == nil {
        guard !Task.isCancelled, let (stream, hold) = await reading.observe() else { return nil }
        reader = stream.makeAsyncIterator()
        subscription = hold
      }
      let state = await reader?.next()
      if state == nil || reading.ended() || Task.isCancelled {
        subscription?.dispose()
        return nil
      }
      return state
    }
  }

  public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(reading: reading) }
  public func fresh() async throws -> Value { try await reading.fresh() }
  public func invalidate() async { await reading.invalidate() }

  /// The entry this query holds. A view only reads another query's.
  private var entry: CacheEntry<Value> {
    guard let held else { preconditionFailure("A view of a query is read, never written") }
    return held
  }

  func refreshIfKnown(coalescing: Bool) async { await entry.refreshIfKnown(coalescing: coalescing) }
  func writeIfKnown(_ value: Value) async { await entry.writeIfKnown(value) }
  func editIfKnown(_ change: @escaping @Sendable (Value) -> Value) async {
    await entry.editIfKnown(change)
  }
  func removeIfKnown(_ error: BusRequestError) async { await entry.removeIfKnown(error) }
  func snapshot() async -> Value? { await entry.snapshot() }
  func isKnown() async -> Bool { await entry.isKnown }
  func replace(_ state: CacheState<Value>) async { await entry.replace(state) }
  func keepingStarted(absorb: @Sendable (Value?) -> Void) async {
    await entry.keepingStarted(absorb: absorb)
  }
}

private actor CacheEntry<Value: Sendable> {
  typealias State = CacheState<Value>
  private let lifetime: Lifetime
  private let fetch: @Sendable () async throws -> Value
  private let hold: (@Sendable () async -> ResourceHold)?
  private let kept: KeptValue<Value>?
  private let owed: Unsettled?
  private let invalidationWindowMs: Int
  private let clock: any Clock<Duration>
  private var rehydrated = false
  private var state: State = .pending
  /// Its failure says its entity is gone (B13a), not that a fetch failed.
  private var gone = false
  private var listeners:
    [UUID: (yield: @Sendable (State) -> Void, finish: @Sendable () -> Void, scope: ResourceHold?)] =
      [:]
  private var flights: [UUID: Task<Value, any Error>] = [:]
  private var flightEdits: [UUID: [@Sendable (Value) -> Value]] = [:]
  private var current: UUID?
  private var validation: UUID?
  private var mutation: UInt64 = 0
  private var windowOpen = false
  private var refreshOwed = false

  init(
    lifetime: Lifetime, hold: (@Sendable () async -> ResourceHold)?,
    kept: KeptValue<Value>?, owed: Unsettled?, invalidationWindowMs: Int,
    clock: any Clock<Duration>, fetch: @escaping @Sendable () async throws -> Value
  ) {
    self.lifetime = lifetime
    self.clock = clock
    self.hold = hold
    self.fetch = fetch
    self.kept = kept
    self.owed = owed
    self.invalidationWindowMs = invalidationWindowMs
    if let value = kept?.load() {
      state = .ready(value)
      rehydrated = true
    }
  }

  nonisolated var ended: Bool { lifetime.ended }

  /// Its client started keeping (B17): it takes the kept value when it holds none and asks for
  /// none. Otherwise `absorb` makes what is kept agree with it, owing no save, so the next
  /// change's save writes it: the value it holds, or nothing of an entity gone. A failed fetch
  /// leaves what was kept, as a key whose refetch failed keeps the value it last had.
  func keepingStarted(absorb: @Sendable (Value?) -> Void) {
    switch state {
    case .pending:
      guard current == nil, validation == nil, let value = kept?.load() else { return }
      state = .ready(value)
      rehydrated = true
      for listener in listeners.values { listener.yield(state) }
    case .ready(let value): if !rehydrated { absorb(value) }
    case .failed: if gone { absorb(nil) }
    }
  }

  var isKnown: Bool {
    guard !lifetime.ended else { return false }
    if case .pending = state { return current != nil || validation != nil }
    return true
  }

  func snapshot() -> Value? {
    guard !lifetime.ended, case .ready(let value) = state else { return nil }
    return value
  }

  func observe<Seen: Sendable>(seeing see: @escaping @Sendable (Value) -> Seen) async
    -> (AsyncStream<CacheState<Seen>>, ResourceHold)?
  {
    guard !lifetime.ended, !Task.isCancelled else { return nil }
    let scope = await hold?()
    guard !lifetime.ended, !Task.isCancelled else {
      scope?.dispose()
      return nil
    }
    switch state {
    case .ready: if rehydrated { revalidate() }
    case .failed:
      publish(.pending)
      revalidate()
    case .pending: revalidate()
    }
    let id = UUID()
    let (stream, continuation) = AsyncStream<CacheState<Seen>>.makeStream(
      bufferingPolicy: .unbounded)
    listeners[id] = ({ _ = continuation.yield($0.map(see)) }, { continuation.finish() }, scope)
    continuation.yield(state.map(see))
    return (
      stream,
      ResourceHold { [weak self] in
        scope?.dispose()
        Task { await self?.remove(id) }
      }
    )
  }

  private func remove(_ id: UUID) { listeners.removeValue(forKey: id)?.finish() }

  /// A settled value is kept; a failed fetch leaves what is kept alone.
  private func publish(_ state: State) {
    self.state = state
    gone = false
    if case .ready(let value) = state { kept?.store(value) }
    for listener in listeners.values { listener.yield(state) }
  }

  private func fetching() -> Task<Value, any Error> {
    if let current, let flight = flights[current] { return flight }
    rehydrated = false
    kept?.underway.begin()
    let id = UUID()
    let revision = mutation
    let task = Task {
      defer {
        kept?.underway.end()
        flights.removeValue(forKey: id)
        flightEdits.removeValue(forKey: id)
        if current == id { current = nil }
      }
      try Task.checkCancellation()
      let value = try await fetch()
      guard !lifetime.ended else { throw CancellationError() }
      if mutation == revision {
        let edited = (flightEdits[id] ?? []).reduce(value) { value, edit in edit(value) }
        publish(.ready(edited))
      }
      return value
    }
    current = id
    flights[id] = task
    return task
  }

  func fresh() async throws -> Value {
    let closed = BusRequestError(.busClosed, "The client is closed")
    guard !lifetime.ended else { throw closed }
    try Task.checkCancellation()
    let flight = fetching()
    let waiter = SharedWait<Value>()
    let ending = lifetime.onEnd { waiter.resolve(.failure(closed)) }
    defer { lifetime.forgetEnding(ending) }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        waiter.install(continuation)
        Task { waiter.resolve(await flight.result) }
      }
    } onCancel: {
      waiter.resolve(.failure(CancellationError()))
    }
  }

  func invalidate() {
    guard !lifetime.ended else { return }
    current = nil
    validation = nil
    if case .failed = state { publish(.pending) }
    revalidate()
  }

  private func revalidate() {
    guard validation == nil else { return }
    let id = UUID()
    validation = id
    let first = fetching()
    kept?.underway.begin()
    lifetime.start {
      defer { self.kept?.underway.end() }
      await self.validate(first, id: id)
    }
  }

  private func validate(_ first: Task<Value, any Error>, id: UUID) async {
    defer { if validation == id { validation = nil } }
    guard case .failure(let error) = await first.result, !(error is CancellationError),
      !lifetime.ended, validation == id
    else { return }
    guard case .failure(let retryError) = await fetching().result,
      !(retryError is CancellationError),
      !lifetime.ended, validation == id
    else { return }
    if case .pending = state { publish(.failed(retryError)) }
  }

  func refreshIfKnown(coalescing: Bool) {
    guard isKnown else { return }
    if !coalescing {
      invalidate()
    } else if windowOpen {
      if !refreshOwed { owed?.begin() }
      refreshOwed = true
    } else {
      openWindow()
    }
  }

  func writeIfKnown(_ value: Value) {
    guard isKnown else { return }
    replace(.ready(value))
  }

  func editIfKnown(_ change: @escaping @Sendable (Value) -> Value) {
    guard isKnown else { return }
    // Keep unrelated changes from reads already underway, applying the edit to their answers too.
    for id in flights.keys { flightEdits[id, default: []].append(change) }
    if case .ready(let value) = state { publish(.ready(change(value))) }
  }

  func removeIfKnown(_ error: BusRequestError) {
    guard isKnown else { return }
    replace(.failed(error))
  }

  /// A value written, or one gone (B13a), which is then kept no longer.
  func replace(_ state: State) {
    guard !lifetime.ended else { return }
    // Earlier reads can finish for their callers but cannot undo a bus mutation.
    mutation &+= 1
    rehydrated = false
    current = nil
    validation = nil
    let wasOwed = refreshOwed
    refreshOwed = false
    publish(state)
    if case .failed = state {
      gone = true
      kept?.forget()
    }
    if wasOwed { owed?.end() }
  }

  private func openWindow() {
    invalidate()
    windowOpen = true
    let clock = clock
    lifetime.start {
      guard (try? await sleepMilliseconds(self.invalidationWindowMs, on: clock)) != nil else {
        return
      }
      await self.closeWindow()
    }
  }

  private func closeWindow() {
    windowOpen = false
    if refreshOwed, !lifetime.ended {
      refreshOwed = false
      openWindow()
      owed?.end()
    }
  }

  func close() {
    for flight in flights.values { flight.cancel() }
    for listener in listeners.values {
      listener.scope?.dispose()
      listener.finish()
    }
    flights.removeAll()
    flightEdits.removeAll()
    listeners.removeAll()
    if refreshOwed { owed?.end() }
    refreshOwed = false
  }
}
