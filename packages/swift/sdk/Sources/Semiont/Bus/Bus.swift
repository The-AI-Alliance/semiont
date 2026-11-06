import Foundation

/// The typed bus over a transport. A request it sends waits for its reply on its clock, for
/// `busRequestTimeoutMs` unless its caller gives another deadline, whatever the transport.
public struct Bus: Sendable {
  private let transport: any Transport
  private let busRequestTimeoutMs: Int
  private let clock: any Clock<Duration>
  public init(
    _ transport: any Transport, busRequestTimeoutMs: Int? = nil,
    clock: any Clock<Duration> = ContinuousClock()
  ) {
    self.transport = transport
    self.busRequestTimeoutMs = busRequestTimeoutMs ?? Timings.busRequestTimeoutMs
    self.clock = clock
  }
  public func emit<Payload>(
    _ channel: Channel<Payload>, _ payload: Payload, scope: ResourceId? = nil,
    correlationId: String? = nil
  ) async throws -> Int? {
    try await transport.emit(
      channel: channel.name, payload: wirePayload(payload), scope: scope,
      correlationId: correlationId)
  }
  public func frames<Payload>(_ channel: Channel<Payload>) async throws -> Typed<Payload> {
    let source = try await transport.frames([channel.name])
    do { try Task.checkCancellation() } catch {
      source.dispose()
      throw error
    }
    return Typed(channel: channel.name, stamps: channel.stamps, source: source)
  }
  public func frames<Payload>(_ channel: ScopedChannel<Payload>, resource: ResourceId) async throws
    -> Typed<Payload>
  {
    let source = try await transport.frames([channel.name])
    let hold = await transport.subscribeToResource(resource)
    do { try Task.checkCancellation() } catch {
      source.dispose()
      hold.dispose()
      throw error
    }
    return Typed(
      channel: channel.name, stamps: channel.stamps, source: source, resource: resource, hold: hold)
  }
  public func request<Request, Result, Failure>(
    _ operation: Operation<Request, Result, Failure>, _ payload: Request, timeoutMs: Int? = nil
  ) async throws -> Result {
    try await request(operation, payload, timeoutMs: timeoutMs, enqueued: nil)
  }

  func request<Request, Result, Failure>(
    _ operation: Operation<Request, Result, Failure>, _ payload: Request, timeoutMs: Int? = nil,
    enqueued: (@Sendable () -> Void)?
  ) async throws -> Result {
    let answer = try await resultOf(
      operation.request.name, wirePayload(payload), over: transport,
      timeoutMs: timeoutMs ?? busRequestTimeoutMs, clock: clock, enqueued: enqueued)
    do throws(Fault) {
      return try held(
        Result.self, answer.payload, on: operation.result.name, stamps: operation.result.stamps)
    } catch {
      throw TransportError(.error, notTheChannels(operation.result.name, error))
    }
  }
}

/// A request of the operation whose request channel is `operation`, over `transport`, as far as
/// the frame that answers it on the operation's result channel. It fails as timed out once
/// `timeoutMs` has passed on `clock` since it was asked, whatever the transport, which keeps no
/// deadline of its own. Every request the SDK makes is made here: a bus's, a worker's claim and a
/// held job's commit. `parent` is the trace the HTTP transport sends it in. `enqueued` is told when
/// the HTTP transport hands it to the wire, and over any other transport once its reply has come.
package func resultOf(
  _ operation: String, _ payload: [String: JSONValue], over transport: any Transport,
  timeoutMs: Int, clock: any Clock<Duration>, parent: [String: String]? = nil,
  enqueued: (@Sendable () -> Void)? = nil
) async throws -> ReceivedFrame {
  guard let result = wireOperations[operation]?.result else {
    throw BusRequestError(.busRejected, "Unknown operation \(operation)")
  }
  do {
    return try await within(.milliseconds(timeoutMs), on: clock) {
      // The trace a request is sent in, the moment it is handed to the wire and the frame of its
      // reply are what `Transport.request` does not carry; the HTTP transport gives them.
      if let http = transport as? HttpTransport {
        return try await http.requestFrame(
          operation: operation, payload: payload, parent: parent, enqueued: enqueued)
      }
      let answer = try await transport.request(operation: operation, payload: payload)
      enqueued?()
      return ReceivedFrame(channel: result, payload: answer)
    }
  } catch is RequestDeadline {
    throw BusRequestError(.busTimeout, "Bus request timed out after \(timeoutMs)ms on \(result)")
  }
}

/// What every SDK says of a payload on `channel` that has `fault`.
func notTheChannels(_ channel: String, _ fault: Fault) -> String {
  "a payload on \(channel) is not that channel's: \(fault.said)"
}

/// What every SDK says of a frame it refused, for the fault the refusal names.
func notTheFrames(_ refusal: FrameRefusal) -> String {
  "a frame on \(refusal.channel) is not that channel's: "
    + Fault(member: refusal.member, reason: refusal.reason).said
}

/// Reply subscriptions for the given requests, in request order with duplicates removed.
public func replyChannelsFor(_ requests: [String]) -> [String] {
  var seen: Set<String> = []
  return requests.flatMap { request -> [String] in
    guard let operation = wireOperations[request] else { return [] }
    return [operation.result, operation.failure].filter { seen.insert($0).inserted }
  }
}

public func unsubscribed(_ channel: String) -> BusRequestError {
  BusRequestError(.busUnsubscribed, "Transport is not subscribed to \(channel)")
}

public let persistedEventTypes = storedEventChannels
