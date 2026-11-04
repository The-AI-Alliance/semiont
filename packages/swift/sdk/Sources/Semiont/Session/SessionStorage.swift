import Foundation
import Synchronization

/// Application-owned text storage. An update must be atomic with other writers of the same key.
public protocol SessionStorage: Sendable {
  func get(_ key: String) throws -> String?
  func set(_ key: String, _ value: String) throws
  func delete(_ key: String) throws
  func update(_ key: String, _ change: @Sendable (String?) throws -> String?) throws
  func subscribe(_ key: String) -> AsyncStream<String?>?
}

/// Text storage shared by callers in this process.
public final class MemorySessionStorage: SessionStorage, Sendable {
  private struct State: Sendable {
    var values: [String: String] = [:]
    var listeners: [String: [UUID: AsyncStream<String?>.Continuation]] = [:]
  }
  private let state = Mutex(State())

  public init() {}

  public func get(_ key: String) -> String? { state.withLock { $0.values[key] } }
  public func set(_ key: String, _ value: String) { write(key) { _ in value } }
  public func delete(_ key: String) { write(key) { _ in nil } }

  public func update(_ key: String, _ change: @Sendable (String?) throws -> String?) rethrows {
    try write(key, change)
  }

  private func write(_ key: String, _ change: (String?) throws -> String?) rethrows {
    try state.withLock { state in
      let value = try change(state.values[key])
      state.values[key] = value
      for listener in state.listeners[key]?.values ?? [:].values { listener.yield(value) }
    }
  }

  public func subscribe(_ key: String) -> AsyncStream<String?>? {
    let id = UUID()
    let (stream, listener) = AsyncStream<String?>.makeStream()
    state.withLock { $0.listeners[key, default: [:]][id] = listener }
    listener.onTermination = { [weak self] _ in
      self?.state.withLock { state in
        state.listeners[key]?.removeValue(forKey: id)
        if state.listeners[key]?.isEmpty == true { state.listeners.removeValue(forKey: key) }
      }
    }
    return stream
  }
}
