import Foundation

public struct Delivered<Payload: Sendable>: Sendable {
  public let frame: ReceivedFrame
  public let payload: Payload
  public var userId: UserId? {
    guard case .string(let value) = frame.payload["_userId"] else { return nil }
    return UserId.parse(value)
  }
}
public struct FrameRefusal: Sendable {
  public let channel: String
  public let lacks: String?
  public let payload: [String: JSONValue]
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
            return .refused(
              FrameRefusal(
                channel: owner.channel,
                lacks: requiredPayloadMembers[owner.channel]?.lacking(
                  in: .object(declared(frame.payload, stamps: owner.stamps))),
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
/// Generated schema structure used only to describe a malformed payload's missing member.
indirect enum RequiredMembers: Sendable {
  case opaque
  case reference(String)
  case object(required: [String: Bool], members: [String: RequiredMembers])
  case list(RequiredMembers)
  case map(RequiredMembers)
  func lacking(in value: JSONValue, path: [String] = []) -> String? {
    switch (self, value) {
    case (.reference(let name), _):
      guard let shape = requiredModelMembers[name] else {
        preconditionFailure("Missing generated schema: \(name)")
      }
      return shape.lacking(in: value, path: path)
    case (.object(let required, let members), .object(let values)):
      for key in required.keys.sorted() {
        if values[key] == nil || (values[key] == .null && required[key] == false) {
          return (path + [key]).joined(separator: ".")
        }
      }
      for key in members.keys.sorted() {
        if let value = values[key], let lacks = members[key]?.lacking(in: value, path: path + [key])
        {
          return lacks
        }
      }
    case (.list(let item), .array(let values)):
      for value in values { if let lacks = item.lacking(in: value, path: path) { return lacks } }
    case (.map(let item), .object(let values)):
      for key in values.keys.sorted() {
        if let value = values[key], let lacks = item.lacking(in: value, path: path) { return lacks }
      }
    default: break
    }
    return nil
  }
}
