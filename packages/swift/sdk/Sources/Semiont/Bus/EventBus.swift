import Foundation
import Synchronization

/// The client's own signals and the wire events bridged into it.
public final class EventBus: Sendable {
  private struct State: Sendable {
    var ended = false
    var listeners: [UUID: (String, Broadcast<ReceivedFrame>)] = [:]
  }
  private let dispatch = Mutex(())
  private let state = Mutex(State())
  public init() {}
  public func emit<Payload>(
    _ channel: Channel<Payload>, _ payload: Payload, correlationId: String? = nil
  ) throws {
    let frame = ReceivedFrame(
      channel: channel.name, correlationId: correlationId, payload: try wirePayload(payload))
    try dispatch.withLock { _ in
      guard !state.withLock({ $0.ended }) else {
        throw BusRequestError(.busClosed, "The local bus closed")
      }
      publish(frame)
    }
  }
  public func frames<Payload>(_ channel: Channel<Payload>) -> Typed<Payload> {
    Typed(channel: channel.name, stamps: channel.stamps, source: listen(channel.name))
  }
  public func frames<Payload>(_ channel: ScopedChannel<Payload>, resource: ResourceId) -> Typed<
    Payload
  > {
    Typed(
      channel: channel.name, stamps: channel.stamps, source: listen(channel.name),
      resource: resource)
  }
  func listen(_ channel: String) -> Events<ReceivedFrame> {
    let id = UUID()
    let hub = Broadcast<ReceivedFrame>()
    let source = hub.listen { [weak self] in self?.remove(id) }
    let ended = state.withLock { state in
      if state.ended { return true }
      state.listeners[id] = (channel, hub)
      return false
    }
    if ended { hub.finish() }
    return source
  }
  private func remove(_ id: UUID) { _ = state.withLock { $0.listeners.removeValue(forKey: id) } }
  private func publish(_ frame: ReceivedFrame) {
    let listeners = state.withLock { state in
      state.ended ? [] : state.listeners.values.filter { $0.0 == frame.channel }.map(\.1)
    }
    for listener in listeners { listener.yield(frame) }
  }
  func receive(_ frame: ReceivedFrame) { dispatch.withLock { _ in publish(frame) } }
  public func dispose() {
    dispatch.withLock { _ in
      let listeners = state.withLock { state in
        state.ended = true
        let listeners = state.listeners.values.map(\.1)
        state.listeners.removeAll()
        return listeners
      }
      for listener in listeners { listener.finish() }
    }
  }
  deinit { dispose() }
}
