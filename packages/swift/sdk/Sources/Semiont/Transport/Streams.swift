import Foundation
import Synchronization

/// Each call creates an independent unbounded queue, beginning at the call.
package final class Broadcast<Value: Sendable>: Sendable {
  package init() {}
  private struct State: Sendable {
    var listeners: [UUID: AsyncThrowingStream<Value, any Error>.Continuation] = [:]
    var closed = false
  }
  private let state = Mutex(State())
  package func listen(onTermination: @escaping @Sendable () -> Void = {}) -> Events<Value> {
    let (stream, continuation) = AsyncThrowingStream<Value, any Error>.makeStream(
      bufferingPolicy: .unbounded)
    let id = UUID()
    continuation.onTermination = { [weak self] _ in
      self?.remove(id)
      onTermination()
    }
    let closed = state.withLock { state in
      if state.closed { return true }
      state.listeners[id] = continuation
      return false
    }
    if closed { continuation.finish() }
    return Events(stream, stop: { continuation.finish() })
  }
  private func remove(_ id: UUID) { _ = state.withLock { $0.listeners.removeValue(forKey: id) } }
  package func yield(_ value: Value) {
    let listeners = state.withLock { Array($0.listeners.values) }
    for listener in listeners { listener.yield(value) }
  }
  package func finish() {
    let listeners = state.withLock { state in
      state.closed = true
      let listeners = Array(state.listeners.values)
      state.listeners.removeAll()
      return listeners
    }
    for listener in listeners { listener.finish() }
  }
}

/// Read-only current state and a sequence that includes its value at subscription.
public final class Watched<Value: Sendable>: AsyncSequence, Sendable {
  public typealias Element = Value
  public typealias AsyncIterator = AsyncStream<Value>.Iterator
  private struct State: Sendable {
    var value: Value
    var ended = false
    var listeners: [UUID: AsyncStream<Value>.Continuation] = [:]
  }
  private let updatesLifetime = Lifetime()
  private let state: Mutex<State>
  package init(_ value: Value) { state = Mutex(State(value: value)) }
  public convenience init(_ initial: Value, updates: AsyncStream<Value>) {
    self.init(initial)
    let id = UUID()
    let life = updatesLifetime
    let task = Task { [weak self] in
      defer { life.forget(id) }
      for await value in updates {
        if Task.isCancelled { break }
        self?.set(value)
      }
      self?.finish()
    }
    life.keep(task, id: id)
  }
  deinit {
    updatesLifetime.end()
    finish()
  }
  package func finish() {
    let listeners = state.withLock { state in
      state.ended = true
      let listeners = Array(state.listeners.values)
      state.listeners.removeAll()
      return listeners
    }
    for listener in listeners { listener.finish() }
  }
  public var value: Value { state.withLock { $0.value } }
  public func makeAsyncIterator() -> AsyncIterator { observations().makeAsyncIterator() }
  func observations() -> AsyncStream<Value> {
    let (stream, continuation) = AsyncStream<Value>.makeStream(bufferingPolicy: .unbounded)
    let id = UUID()
    continuation.onTermination = { [weak self] _ in self?.remove(id) }
    let ended = state.withLock { state in
      continuation.yield(state.value)
      if !state.ended { state.listeners[id] = continuation }
      return state.ended
    }
    if ended { continuation.finish() }
    return stream
  }
  private func remove(_ id: UUID) { _ = state.withLock { $0.listeners.removeValue(forKey: id) } }
  package func set(_ value: Value) {
    let listeners = state.withLock { state in
      guard !state.ended else { return [AsyncStream<Value>.Continuation]() }
      state.value = value
      return Array(state.listeners.values)
    }
    for listener in listeners { listener.yield(value) }
  }
  func finish(with value: Value) {
    let listeners = state.withLock { state in
      guard !state.ended else { return [AsyncStream<Value>.Continuation]() }
      state.value = value
      state.ended = true
      let listeners = Array(state.listeners.values)
      state.listeners.removeAll()
      return listeners
    }
    for listener in listeners {
      listener.yield(value)
      listener.finish()
    }
  }
}

final class Lifetime: Sendable {
  private struct State: Sendable {
    var ended = false
    var tasks: [UUID: @Sendable () -> Void] = [:]
    var endings: [UUID: @Sendable () -> Void] = [:]
  }
  private let state = Mutex(State())
  var ended: Bool { state.withLock { $0.ended } }
  func whileOpen(_ action: () -> Void) {
    state.withLock { state in
      if !state.ended { action() }
    }
  }
  func keep<Value: Sendable, Failure: Error>(_ task: Task<Value, Failure>, id: UUID) {
    let ended = state.withLock { state in
      if state.ended { return true }
      state.tasks[id] = { task.cancel() }
      return false
    }
    if ended { task.cancel() }
  }
  func start(_ work: @escaping @Sendable () async -> Void) {
    let id = UUID()
    state.withLock { state in
      guard !state.ended else { return }
      let task = Task {
        defer { self.forget(id) }
        guard !Task.isCancelled else { return }
        await work()
      }
      state.tasks[id] = { task.cancel() }
    }
  }
  func cancel(_ id: UUID) { state.withLock { $0.tasks[id] }?() }
  func forget(_ id: UUID) { _ = state.withLock { $0.tasks.removeValue(forKey: id) } }
  @discardableResult
  func onEnd(id: UUID = UUID(), _ action: @escaping @Sendable () -> Void) -> UUID {
    let ended = state.withLock { state in
      if state.ended { return true }
      state.endings[id] = action
      return false
    }
    if ended { action() }
    return id
  }
  func forgetEnding(_ id: UUID) { _ = state.withLock { $0.endings.removeValue(forKey: id) } }
  func end() {
    let held = state.withLock { state in
      state.ended = true
      let tasks = Array(state.tasks.values)
      let endings = Array(state.endings.values)
      state.tasks.removeAll()
      state.endings.removeAll()
      return (tasks, endings)
    }
    for cancel in held.0 { cancel() }
    for action in held.1 { action() }
  }
}

public final class ResourceHold: Sendable {
  private let release: Mutex<(@Sendable () -> Void)?>
  public init(_ release: @escaping @Sendable () -> Void) { self.release = Mutex(release) }
  public func dispose() {
    let action = release.withLock { action in
      let held = action
      action = nil
      return held
    }
    action?()
  }
  deinit { dispose() }
}

public struct MultipleConsumers: Error, Sendable {}

/// One listener's ordered, lossless sequence. A second iterator is explicitly refused.
public final class Events<Value: Sendable>: AsyncSequence, Sendable {
  public typealias Element = Value
  private let stream: AsyncThrowingStream<Value, any Error>
  private let claimed = Mutex(false)
  private let demand: @Sendable () -> Void
  private let stop: @Sendable () -> Void
  public init(
    _ stream: AsyncThrowingStream<Value, any Error>, demand: @escaping @Sendable () -> Void = {},
    stop: @escaping @Sendable () -> Void
  ) {
    self.stream = stream
    self.demand = demand
    self.stop = stop
  }
  public struct AsyncIterator: AsyncIteratorProtocol {
    private let owner: Events<Value>
    private var iterator: AsyncThrowingStream<Value, any Error>.Iterator
    let rejected: Bool
    fileprivate init(owner: Events<Value>, rejected: Bool) {
      self.owner = owner
      self.rejected = rejected
      iterator = owner.stream.makeAsyncIterator()
    }
    public mutating func next() async throws -> Value? {
      if rejected { throw MultipleConsumers() }
      owner.demand()
      return try await iterator.next()
    }
  }
  public func makeAsyncIterator() -> AsyncIterator {
    let rejected = claimed.withLock { claimed in
      let previous = claimed
      claimed = true
      return previous
    }
    return AsyncIterator(owner: self, rejected: rejected)
  }
  public func dispose() { stop() }
  deinit { stop() }
}

/// Cancellation settles this waiter without cancelling the shared operation.
package final class SharedWait<Value: Sendable>: Sendable {
  package init() {}
  private struct State: Sendable {
    var result: Result<Value, any Error>?
    var continuation: CheckedContinuation<Value, any Error>?
  }
  private let state = Mutex(State())
  package func install(_ continuation: CheckedContinuation<Value, any Error>) {
    let result: Result<Value, any Error>? = state.withLock { state in
      if let result = state.result { return result }
      state.continuation = continuation
      return nil
    }
    if let result { continuation.resume(with: result) }
  }
  package func resolve(_ result: Result<Value, any Error>) {
    let continuation: CheckedContinuation<Value, any Error>? = state.withLock { state in
      guard state.result == nil else { return nil }
      state.result = result
      let continuation = state.continuation
      state.continuation = nil
      return continuation
    }
    continuation?.resume(with: result)
  }
}
func sharedValue<Value: Sendable>(_ task: Task<Value, any Error>, lifetime: Lifetime) async throws
  -> Value
{
  let waiter = SharedWait<Value>()
  let id = UUID()
  return try await withTaskCancellationHandler {
    try await withCheckedThrowingContinuation { continuation in
      waiter.install(continuation)
      let observer = Task {
        defer { lifetime.forget(id) }
        waiter.resolve(await task.result)
      }
      lifetime.keep(observer, id: id)
    }
  } onCancel: {
    waiter.resolve(.failure(CancellationError()))
  }
}
