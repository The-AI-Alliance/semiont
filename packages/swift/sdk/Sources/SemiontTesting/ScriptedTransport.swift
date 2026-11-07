import Foundation
import Semiont
import Synchronization

public typealias Respond =
  @Sendable (String, [String: JSONValue]) async throws -> [String: JSONValue]

public enum FaultAction: Sendable, Equatable {
  case deliver, dropReply
  case delay(Duration)
  case duplicateReply, rejectEmit
}

public struct RequestAttempt: Sendable {
  public let operation: String
  public let payload: [String: JSONValue]
  public let action: FaultAction
}

/// A transport for composing SDK clients without a network. Faults are consumed in request order.
/// It keeps no deadline: a dropped reply never comes, and the bus that asked fails the request at
/// its own.
public final class ScriptedTransport: Transport {
  private struct State: Sendable {
    var attempts: [RequestAttempt] = []
    var queued: [String: [[String: JSONValue]]] = [:]
    var closed = false
    var pending: [UUID: Task<[String: JSONValue], any Error>] = [:]
  }

  public let baseUrl: String
  public let state = Watched<ConnectionState>(.open)
  private let events = Broadcast<Carried>()
  private let errors = Broadcast<TransportError>()
  private let wire = Mutex(State())
  private let schedule: [FaultAction]
  let clock: any Clock<Duration>
  private let respond: Respond

  public init(
    baseUrl: String = "http://localhost:4000", schedule: [FaultAction] = [],
    clock: any Clock<Duration> = ContinuousClock(), respond: Respond? = nil
  ) {
    self.baseUrl = baseUrl
    self.schedule = schedule
    self.clock = clock
    self.respond =
      respond ?? { operation, _ in
        throw BusRequestError(.busRejected, "No scripted answer to \(operation)")
      }
  }

  public var attempts: [RequestAttempt] { wire.withLock { $0.attempts } }

  public func queue(_ operation: String, reply: [String: JSONValue]) {
    wire.withLock { if !$0.closed { $0.queued[operation, default: []].append(reply) } }
  }

  /// Deliver a frame, or a frame's refusal in its place, as the transport's stream would.
  public func deliver(_ carried: Carried) { events.yield(carried) }

  public func frames(_ channels: [String]) async throws -> Events<Carried> {
    let source = events.listen()
    guard !channels.isEmpty else { return source }
    let selected = Set(channels)
    let (stream, continuation) = AsyncThrowingStream<Carried, any Error>.makeStream()
    let task = Task {
      do {
        for try await carried in source where selected.contains(carried.channel) {
          continuation.yield(carried)
        }
        continuation.finish()
      } catch {
        continuation.finish(throwing: error)
      }
    }
    continuation.onTermination = { _ in
      task.cancel()
      source.dispose()
    }
    return Events(stream, stop: { continuation.finish() })
  }

  public func subscribeToResource(_ resource: ResourceId) async -> ResourceHold { ResourceHold {} }

  public func emit(
    channel: String, payload: [String: JSONValue], scope: ResourceId?, correlationId: String?
  ) async throws -> Int? {
    try Task.checkCancellation()
    guard !wire.withLock({ $0.closed }) else { throw closed() }
    return 1
  }

  public func request(operation: String, payload: [String: JSONValue]) async throws
    -> [String: JSONValue]
  {
    try Task.checkCancellation()
    let id = UUID()
    let task = try wire.withLock { wire -> Task<[String: JSONValue], any Error> in
      guard !wire.closed else { throw closed() }
      let index = wire.attempts.count
      let action = schedule.indices.contains(index) ? schedule[index] : .deliver
      wire.attempts.append(RequestAttempt(operation: operation, payload: payload, action: action))
      let reply = wire.queued[operation]?.first
      if reply != nil { wire.queued[operation]?.removeFirst() }
      let task = Task { [clock, respond, events] in
        switch action {
        case .rejectEmit:
          throw BusRequestError(.busPeerUnavailable, "The scripted wire rejected \(operation)")
        case .dropReply:
          let never = SharedWait<Void>()
          try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { never.install($0) }
          } onCancel: {
            never.resolve(.failure(CancellationError()))
          }
        case .delay(let duration):
          try await clock.sleep(for: duration)
        case .deliver, .duplicateReply: break
        }
        try Task.checkCancellation()
        let answer: [String: JSONValue]
        if let reply { answer = reply } else { answer = try await respond(operation, payload) }
        try Task.checkCancellation()
        if let channel = replyChannelsFor([operation]).first {
          let frame = ReceivedFrame(channel: channel, correlationId: id.uuidString, payload: answer)
          events.yield(.frame(frame))
          if action == .duplicateReply { events.yield(.frame(frame)) }
        }
        return answer
      }
      wire.pending[id] = task
      return task
    }
    defer { _ = wire.withLock { $0.pending.removeValue(forKey: id) } }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }

  public func failures() -> Events<TransportError> { errors.listen() }

  public func dispose() {
    let pending = wire.withLock { wire in
      wire.closed = true
      let pending = Array(wire.pending.values)
      wire.pending.removeAll()
      return pending
    }
    for task in pending { task.cancel() }
    state.set(.closed)
    state.finish()
    errors.finish()
    events.finish()
  }

  deinit { dispose() }

  private func closed() -> BusRequestError {
    BusRequestError(.busClosed, "The scripted wire closed")
  }
}
