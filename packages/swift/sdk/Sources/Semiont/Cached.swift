import Foundation

public enum CacheState<Value: Sendable>: Sendable {
  case pending
  case ready(Value)
  case failed(any Error)
}

/// A read-through query. Iteration watches its shared state and fresh() asks for a current answer.
public final class Cached<Value: Sendable>: AsyncSequence, Sendable {
  public typealias Element = CacheState<Value>
  private let entry: CacheEntry<Value>

  init(lifetime: Lifetime, fetch: @escaping @Sendable () async throws -> Value) {
    let entry = CacheEntry(lifetime: lifetime, fetch: fetch)
    self.entry = entry
    lifetime.onEnd { [weak entry] in
      Task { await entry?.close() }
    }
  }

  public struct AsyncIterator: AsyncIteratorProtocol {
    private let entry: CacheEntry<Value>
    private var reader: AsyncStream<Element>.Iterator?
    private var subscription: ResourceHold?

    fileprivate init(entry: CacheEntry<Value>) { self.entry = entry }

    public mutating func next() async -> Element? {
      guard !entry.ended, !Task.isCancelled else {
        subscription?.dispose()
        return nil
      }
      if reader == nil {
        guard !Task.isCancelled, let (stream, hold) = await entry.observe() else { return nil }
        reader = stream.makeAsyncIterator()
        subscription = hold
      }
      let state = await reader?.next()
      if state == nil || entry.ended || Task.isCancelled {
        subscription?.dispose()
        return nil
      }
      return state
    }
  }

  public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(entry: entry) }
  public func fresh() async throws -> Value { try await entry.fresh() }
  public func invalidate() async { await entry.invalidate() }
  func refreshIfKnown(coalescing: Bool) async { await entry.refreshIfKnown(coalescing: coalescing) }
}

private actor CacheEntry<Value: Sendable> {
  typealias State = CacheState<Value>
  private let lifetime: Lifetime
  private let fetch: @Sendable () async throws -> Value
  private var state: State = .pending
  private var listeners: [UUID: AsyncStream<State>.Continuation] = [:]
  private var flights: [UUID: Task<Value, any Error>] = [:]
  private var current: UUID?
  private var validation: UUID?
  private var known = false
  private var windowOpen = false
  private var refreshOwed = false

  init(lifetime: Lifetime, fetch: @escaping @Sendable () async throws -> Value) {
    self.lifetime = lifetime
    self.fetch = fetch
  }

  nonisolated var ended: Bool { lifetime.ended }

  func observe() -> (AsyncStream<State>, ResourceHold)? {
    guard !lifetime.ended else { return nil }
    switch state {
    case .ready: break
    case .failed:
      publish(.pending)
      revalidate()
    case .pending: revalidate()
    }
    let id = UUID()
    let (stream, continuation) = AsyncStream<State>.makeStream(bufferingPolicy: .unbounded)
    listeners[id] = continuation
    continuation.yield(state)
    return (
      stream,
      ResourceHold { [weak self] in
        Task { await self?.remove(id) }
      }
    )
  }

  private func remove(_ id: UUID) { listeners.removeValue(forKey: id)?.finish() }

  private func publish(_ state: State) {
    self.state = state
    for listener in listeners.values { listener.yield(state) }
  }

  private func fetching() -> Task<Value, any Error> {
    if let current, let flight = flights[current] { return flight }
    known = true
    let id = UUID()
    let task = Task {
      defer {
        flights.removeValue(forKey: id)
        if current == id { current = nil }
      }
      try Task.checkCancellation()
      let value = try await fetch()
      guard !lifetime.ended else { throw CancellationError() }
      publish(.ready(value))
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
    lifetime.start { await self.validate(first, id: id) }
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
    guard known, !lifetime.ended else { return }
    if !coalescing {
      invalidate()
    } else if windowOpen {
      refreshOwed = true
    } else {
      openWindow()
    }
  }

  private func openWindow() {
    invalidate()
    windowOpen = true
    lifetime.start {
      guard (try? await sleepMilliseconds(Timings.invalidationWindowMs)) != nil else { return }
      await self.closeWindow()
    }
  }

  private func closeWindow() {
    windowOpen = false
    if refreshOwed, !lifetime.ended {
      refreshOwed = false
      openWindow()
    }
  }

  func close() {
    for flight in flights.values { flight.cancel() }
    for listener in listeners.values { listener.finish() }
    flights.removeAll()
    listeners.removeAll()
    refreshOwed = false
  }
}
