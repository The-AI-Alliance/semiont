import Foundation

public struct Delivered<Payload: Sendable>: Sendable {
  public let frame: ReceivedFrame
  public let payload: Payload
  public var userId: UserId? {
    guard case .string(let value) = frame.payload["_userId"] else { return nil }
    return UserId.parse(value)
  }
}
/// A frame whose payload is not its channel's, in its place: the channel, the payload's first
/// fault (`member`, the way to the member it is at, empty for the payload itself, and `reason`),
/// and the payload as it came.
public struct FrameRefusal: Sendable {
  public let channel: String
  public let member: String
  public let reason: FrameRefusalReason
  public let payload: [String: JSONValue]
}
/// Why a payload is refused: `lacks`, it does not carry a member its schema requires, or the
/// member holds null where it may not; `malformed`, a member is not what its schema allows (of
/// another kind, a value it does not list, a form or a size it does not allow), or is one a
/// closed object does not name.
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
func decodePayload<Value: Decodable>(
  _ type: Value.Type, from payload: [String: JSONValue], stamps: Set<String>
) throws -> Value {
  try JSONDecoder().decode(type, from: JSONEncoder().encode(declared(payload, stamps: stamps)))
}

extension ReceivedFrame {
  func decode<Value>(_ channel: Channel<Value>) throws -> Value {
    try decodePayload(Value.self, from: payload, stamps: channel.stamps)
  }
}

/// Lossless, from-now-on frames. A malformed payload is refused in its place.
public final class Typed<Payload: Codable & Sendable>: AsyncSequence, Sendable {
  public typealias Element = Heard<Payload>
  private let channel: String
  private let stamps: Set<String>
  private let source: Events<ReceivedFrame>
  private let resource: ResourceId?
  private let hold: ResourceHold?
  init(
    channel: String, stamps: Set<String>, source: Events<ReceivedFrame>,
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
    private var iterator: Events<ReceivedFrame>.AsyncIterator
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
        while let frame = try await iterator.next() {
          if frame.channel != owner.channel { continue }
          if let resource = owner.resource, frame.scope != resource { continue }
          do {
            let decoded = try decodePayload(Payload.self, from: frame.payload, stamps: owner.stamps)
            return .delivered(Delivered(frame: frame, payload: decoded))
          } catch {
            let fault = refusedFault(
              of: declared(frame.payload, stamps: owner.stamps), on: owner.channel)
            return .refused(
              FrameRefusal(
                channel: owner.channel, member: fault.member, reason: fault.reason,
                payload: frame.payload))
          }
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
