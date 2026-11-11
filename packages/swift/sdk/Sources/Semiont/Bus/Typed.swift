import Foundation

public struct Delivered<Payload: Sendable>: Sendable {
  public let frame: ReceivedFrame
  public let payload: Payload
  public var userId: UserId? {
    guard case .string(let value) = frame.payload["_userId"] else { return nil }
    return UserId.parse(value)
  }
}
/// What a transport delivers on a channel, one after another: a frame, or, in the place of a frame
/// BusFrame does not allow that names its channel's readers, the frame's refusal.
public enum Carried: Sendable {
  case frame(ReceivedFrame)
  case refused(FrameRefusal)

  /// The channel it was delivered on.
  public var channel: String {
    switch self {
    case .frame(let frame): frame.channel
    case .refused(let refusal): refusal.channel
    }
  }
  /// What pairs it with the request awaiting it, when it carries one BusFrame allows.
  public var correlationId: String? {
    switch self {
    case .frame(let frame): frame.correlationId
    case .refused(let refusal): refusal.correlationId
    }
  }
  /// The resource whose scope it was delivered on.
  package var scope: ResourceId? {
    switch self {
    case .frame(let frame): frame.scope
    case .refused(let refusal): refusal.scope
    }
  }
}
/// A frame refused, in its place: BusFrame does not allow it, or its payload is not its channel's.
/// `member` is the way from the frame to the member its first fault is at, the names of the
/// members it is within and its own joined by dots (`payload.resourceId` is within its payload, and
/// `payload` is the payload itself); `reason` is why. `payload` is its payload as it came, the
/// gateway's stamps and all, and nil when it carried none. `correlationId` is the frame's, when it
/// carries one BusFrame allows: a request awaiting the reply it names fails with the refusal at
/// once. `scope` is the resource whose scope it was delivered on.
public struct FrameRefusal: Sendable, Equatable {
  public let channel: String
  public let member: String
  public let reason: FrameRefusalReason
  public let payload: JSONValue?
  public let correlationId: String?
  public let scope: ResourceId?
  public init(
    channel: String, member: String, reason: FrameRefusalReason, payload: JSONValue?,
    correlationId: String?, scope: ResourceId?
  ) {
    self.channel = channel
    self.member = member
    self.reason = reason
    self.payload = payload
    self.correlationId = correlationId
    self.scope = scope
  }
}
/// Why a frame is refused at a member: `lacks`, it does not carry a member its schema requires, or
/// the member holds null where it may not; `malformed`, a member is not what its schema allows (of
/// another kind, a value it does not list, a form or a size it does not allow), or is one a closed
/// object does not name.
public enum FrameRefusalReason: String, Sendable {
  case lacks
  case malformed
}
public enum Heard<Payload: Sendable>: Sendable {
  case delivered(Delivered<Payload>)
  case refused(FrameRefusal)
}
func wirePayload<Value: Encodable>(_ payload: Value) throws -> [String: JSONValue] {
  try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(payload))
}
func declared(_ payload: [String: JSONValue], stamps: Set<String>) -> [String: JSONValue] {
  payload.filter { !$0.key.hasPrefix("_") || stamps.contains($0.key) }
}
/// `payload`, a payload on `channel`, as `Value`, held to the table before it is decoded. What the
/// gateway stamps on a payload (a member whose name begins `_`) is the bus's: one the channel's
/// payload does not declare in `stamps` is left out before it is read, as is a member the table
/// reads as absent. It is refused for its first fault, or, where the table finds none and its
/// decoder refuses it, for the payload itself.
func held<Value: Decodable>(
  _ type: Value.Type, _ payload: [String: JSONValue], on channel: String, stamps: Set<String>
) throws(Fault) -> Value {
  let read = try payloadAsRead(declared(payload, stamps: stamps), on: channel)
  do {
    return try JSONDecoder().decode(type, from: JSONEncoder().encode(read))
  } catch {
    throw Fault.undecoded
  }
}
/// The way from a frame to the member of its payload whose way from the payload is `member`.
private func inPayload(_ member: String) -> String {
  member.isEmpty ? "payload" : "payload.\(member)"
}
/// What a typed read of `channel` gives for `carried`: a frame, its payload decoded, or the refusal
/// of one whose payload is not the channel's; and a frame the transport refused, its refusal as it
/// came.
func heard<Payload: Decodable & Sendable>(
  _ type: Payload.Type, on channel: String, stamps: Set<String>, _ carried: Carried
) -> Heard<Payload> {
  switch carried {
  case .refused(let refusal): return .refused(refusal)
  case .frame(let frame):
    do throws(Fault) {
      let payload = try held(type, frame.payload, on: channel, stamps: stamps)
      return .delivered(Delivered(frame: frame, payload: payload))
    } catch {
      return .refused(
        FrameRefusal(
          channel: frame.channel, member: inPayload(error.member), reason: error.reason,
          payload: .object(frame.payload), correlationId: frame.correlationId, scope: frame.scope))
    }
  }
}

/// Lossless, from-now-on frames. A frame refused, by the transport or because its payload is not
/// the channel's, is refused in its place, and the frames after it follow.
public final class Typed<Payload: Codable & Sendable>: AsyncSequence, Sendable {
  public typealias Element = Heard<Payload>
  private let channel: String
  private let stamps: Set<String>
  private let source: Events<Carried>
  private let resource: ResourceId?
  private let hold: ResourceHold?
  init(
    channel: String, stamps: Set<String>, source: Events<Carried>,
    resource: ResourceId? = nil, hold: ResourceHold? = nil
  ) {
    self.channel = channel
    self.stamps = stamps
    self.source = source
    self.resource = resource
    self.hold = hold
  }
  public struct AsyncIterator: AsyncIteratorProtocol {
    private let owner: Typed<Payload>
    private let finishReading: ResourceHold?
    private let rejected: Bool
    private var iterator: Events<Carried>.AsyncIterator
    fileprivate init(_ owner: Typed<Payload>) {
      self.owner = owner
      let source = owner.source.makeAsyncIterator()
      rejected = source.rejected
      iterator = source
      finishReading = rejected ? nil : ResourceHold { owner.dispose() }
    }
    public mutating func next() async throws -> Heard<Payload>? {
      if rejected { throw MultipleConsumers() }
      do {
        while let carried = try await iterator.next() {
          if carried.channel != owner.channel { continue }
          if let resource = owner.resource, carried.scope != resource { continue }
          return heard(Payload.self, on: owner.channel, stamps: owner.stamps, carried)
        }
        owner.dispose()
        return nil
      } catch {
        if !(error is MultipleConsumers) { owner.dispose() }
        throw error
      }
    }
  }
  public func makeAsyncIterator() -> AsyncIterator { AsyncIterator(self) }
  public func dispose() {
    source.dispose()
    hold?.dispose()
  }
  deinit { dispose() }
}
