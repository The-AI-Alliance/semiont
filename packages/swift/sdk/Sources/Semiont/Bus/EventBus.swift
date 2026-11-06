import Foundation
import Synchronization

/// The client's own signals and the wire events bridged into it, a frame's refusal among them.
public final class EventBus: Sendable {
  private struct State: Sendable {
    var ended = false
    var listeners: [UUID: (Set<String>, Broadcast<Carried>)] = [:]
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
      publish(.frame(frame))
    }
  }
  public func frames<Payload>(_ channel: Channel<Payload>) -> Typed<Payload> {
    Typed(channel: channel.name, stamps: channel.stamps, source: listen([channel.name]))
  }
  public func frames<Payload>(_ channel: ScopedChannel<Payload>, resource: ResourceId) -> Typed<
    Payload
  > {
    Typed(
      channel: channel.name, stamps: channel.stamps, source: listen([channel.name]),
      resource: resource)
  }
  func listen(_ channels: [String]) -> Events<Carried> {
    let id = UUID()
    let hub = Broadcast<Carried>()
    let source = hub.listen { [weak self] in self?.remove(id) }
    let ended = state.withLock { state in
      if state.ended { return true }
      state.listeners[id] = (Set(channels), hub)
      return false
    }
    if ended { hub.finish() }
    return source
  }
  private func remove(_ id: UUID) { _ = state.withLock { $0.listeners.removeValue(forKey: id) } }
  private func publish(_ carried: Carried) {
    let listeners = state.withLock { state in
      state.ended ? [] : state.listeners.values.filter { $0.0.contains(carried.channel) }.map(\.1)
    }
    for listener in listeners { listener.yield(carried) }
  }
  func receive(_ carried: Carried) { dispatch.withLock { _ in publish(carried) } }
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
