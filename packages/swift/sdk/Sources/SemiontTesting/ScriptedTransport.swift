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

/// What a double's stream is subscribed to, as a gateway holds a stream to what it subscribed: the
/// global channels it was given, and each resource whose scope it holds, once for every hold not
/// yet released.
package final class Subscription: Sendable {
  private let channels: [String]
  private let held = Mutex<[ResourceId: Int]>([:])

  package init(channels: [String]) { self.channels = channels }

  /// How many holds are not yet released, over every resource.
  package var holds: Int { held.withLock { $0.values.reduce(0, +) } }

  /// Whether a frame reaches the stream: one with a scope on a resource-scoped channel while that
  /// scope is held, and one with none on a channel it was given.
  package func carries(_ carried: Carried) -> Bool {
    guard let scope = carried.scope else { return channels.contains(carried.channel) }
    return resourceScopedChannels.contains(carried.channel) && held.withLock { $0[scope] != nil }
  }

  /// The first of `channels` the stream can never carry: one neither given nor resource-scoped. A
  /// resource-scoped channel is read with no scope held, and carries nothing until one is.
  package func unreadable(_ channels: [String]) -> String? {
    channels.first { !self.channels.contains($0) && !resourceScopedChannels.contains($0) }
  }

  /// The first reply channel of `operation` it was not given.
  package func unanswered(_ operation: String) -> String? {
    replyChannelsFor([operation]).first { !channels.contains($0) }
  }

  /// Holds `resource`'s scope until the hold is disposed; disposing it again releases nothing more.
  package func hold(_ resource: ResourceId) -> ResourceHold {
    held.withLock { $0[resource, default: 0] += 1 }
    return ResourceHold { [self] in
      held.withLock { held in
        guard let count = held[resource] else {
          preconditionFailure("\(resource.value) was released more often than it was held")
        }
        held[resource] = count > 1 ? count - 1 : nil
      }
    }
  }
}

/// A transport for composing SDK clients without a network. Faults are consumed in request order.
/// It keeps no deadline: a dropped reply never comes, and the bus that asked fails the request at
/// its own. As a real transport, it is given its global channels and assumes none of its own: it
/// delivers those, and a resource-scoped frame only while its scope is held, and refuses a read or a
/// request of another.
public final class ScriptedTransport: Transport {
  private struct State: Sendable {
    var attempts: [RequestAttempt] = []
    var queued: [String: [[String: JSONValue]]] = [:]
    var closed = false
    var pending: [UUID: Task<[String: JSONValue], any Error>] = [:]
  }

  public let baseUrl: String
  public let state = Watched<ConnectionState>(.open)
  private let subscription: Subscription
  private let events = Broadcast<Carried>()
  private let errors = Broadcast<TransportError>()
  private let wire = Mutex(State())
  private let schedule: [FaultAction]
  let clock: any Clock<Duration>
  private let respond: Respond

  public init(
    channels: [String], baseUrl: String = "http://localhost:4000", schedule: [FaultAction] = [],
    clock: any Clock<Duration> = ContinuousClock(), respond: Respond? = nil
  ) {
    self.subscription = Subscription(channels: channels)
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

  /// Deliver a frame, or a frame's refusal in its place, as the transport's stream would: one with
  /// no scope on a channel it was not given, or with a scope it does not hold, never reaches it.
  public func deliver(_ carried: Carried) {
    if subscription.carries(carried) { events.yield(carried) }
  }

  public func frames(_ channels: [String]) async throws -> Events<Carried> {
    if let channel = subscription.unreadable(channels) { throw unsubscribed(channel) }
    let source = events.listen()
    guard !channels.isEmpty else { return source }
    let selected = Set(channels)
    let (stream, continuation) = AsyncThrowingStream<Carried, any Error>.makeStream()
    let task = spawn {
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

  public func subscribeToResource(_ resource: ResourceId) async -> ResourceHold {
    subscription.hold(resource)
  }

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
    if let channel = subscription.unanswered(operation) { throw unsubscribed(channel) }
    try Task.checkCancellation()
    let id = UUID()
    let task = try wire.withLock { wire -> Task<[String: JSONValue], any Error> in
      guard !wire.closed else { throw closed() }
      let index = wire.attempts.count
      let action = schedule.indices.contains(index) ? schedule[index] : .deliver
      wire.attempts.append(RequestAttempt(operation: operation, payload: payload, action: action))
      let reply = wire.queued[operation]?.first
      if reply != nil { wire.queued[operation]?.removeFirst() }
      let task = spawn { [clock, respond, events, subscription] in
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
          let carried = Carried.frame(
            ReceivedFrame(channel: channel, correlationId: id.uuidString, payload: answer))
          if subscription.carries(carried) {
            events.yield(carried)
            if action == .duplicateReply { events.yield(carried) }
          }
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
