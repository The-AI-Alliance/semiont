import Foundation
import Synchronization

/// A lazy operation, consumed once: every report and the final value, or just its completion.
public final class Running<Value: Sendable>: AsyncSequence, Sendable {
  public typealias Element = Value
  private let core: RunningCore<Value>
  init(
    lifetime: Lifetime,
    work: @escaping @Sendable (@escaping @Sendable (Value) -> Void) async throws -> Value
  ) {
    core = RunningCore(lifetime: lifetime, work: work)
  }
  public struct AsyncIterator: AsyncIteratorProtocol {
    private let owner: Running<Value>
    private let core: RunningCore<Value>
    private var reader: AsyncThrowingStream<Value, any Error>.Iterator
    private let rejected: Bool
    private let reading: ResourceHold?
    fileprivate init(_ owner: Running<Value>) {
      self.owner = owner
      let core = owner.core
      self.core = core
      reader = core.stream.makeAsyncIterator()
      rejected = !core.take(reads: true)
      reading = rejected ? nil : ResourceHold { core.stop(CancellationError()) }
    }
    public mutating func next() async throws -> Value? {
      if rejected { throw MultipleConsumers() }
      do {
        try Task.checkCancellation()
        core.begin()
        let value = try await reader.next()
        try Task.checkCancellation()
        return value
      } catch {
        core.stop(error)
        throw error
      }
    }
  }
  public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(self) }
  public func completed() async throws -> Value {
    defer { withExtendedLifetime(self) {} }
    guard core.take(reads: false) else { throw MultipleConsumers() }
    let core = core
    return try await withTaskCancellationHandler {
      try Task.checkCancellation()
      return try await withCheckedThrowingContinuation { continuation in
        core.outcome.install(continuation)
        core.begin()
      }
    } onCancel: {
      core.stop(CancellationError())
    }
  }
  public func dispose() { core.stop(CancellationError()) }
  deinit { dispose() }
}
private final class RunningCore<Value: Sendable>: Sendable {
  private struct State: Sendable {
    var taken = false
    var reads = false
    var result: Result<Value, any Error>?
    var task: Task<Void, Never>?
  }
  private let state = Mutex(State())
  let stream: AsyncThrowingStream<Value, any Error>
  private let continuation: AsyncThrowingStream<Value, any Error>.Continuation
  let outcome = SharedWait<Value>()
  private let lifetime: Lifetime
  private let id = UUID()
  private let work: @Sendable (@escaping @Sendable (Value) -> Void) async throws -> Value
  init(
    lifetime: Lifetime,
    work: @escaping @Sendable (@escaping @Sendable (Value) -> Void) async throws -> Value
  ) {
    self.lifetime = lifetime
    self.work = work
    (stream, continuation) = AsyncThrowingStream.makeStream(bufferingPolicy: .unbounded)
    lifetime.onEnd(id: id) { [weak self] in
      self?.stop(BusRequestError(.busClosed, "The client closed before the operation ended"))
    }
  }
  func take(reads: Bool) -> Bool {
    state.withLock { state in
      if state.taken { return false }
      state.taken = true
      state.reads = reads
      return true
    }
  }
  func begin() {
    state.withLock { state in
      guard state.task == nil, state.result == nil else { return }
      state.task = Task { [self] in
        do {
          try Task.checkCancellation()
          let value = try await work { [weak self] value in self?.report(value) }
          settle(.success(value), cancel: false)
        } catch { settle(.failure(error), cancel: false) }
      }
    }
  }
  func report(_ value: Value) {
    state.withLock { state in
      if state.result == nil && state.reads { continuation.yield(value) }
    }
  }
  private func settle(_ result: Result<Value, any Error>, cancel: Bool) {
    let ended = state.withLock { state -> (Bool, Task<Void, Never>?, Bool) in
      guard state.result == nil else { return (false, nil, false) }
      state.result = result
      let task = state.task
      state.task = nil
      return (true, task, state.reads)
    }
    guard ended.0 else { return }
    if cancel { ended.1?.cancel() }
    lifetime.forgetEnding(id)
    switch result {
    case .success(let value):
      if ended.2 { continuation.yield(value) }
      continuation.finish()
    case .failure(let error): continuation.finish(throwing: error)
    }
    outcome.resolve(result)
  }
  func stop(_ error: any Error) { settle(.failure(error), cancel: true) }
}
