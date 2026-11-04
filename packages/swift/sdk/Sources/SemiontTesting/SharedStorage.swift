import Foundation
import Semiont
import Synchronization

/// Storage contexts share atomic writes. A context only hears changes made by its peers.
public final class SharedStorage: SessionStorage {
  private struct Listener: Sendable {
    let context: UUID
    let continuation: AsyncStream<String?>.Continuation
  }

  private final class Document: Sendable {
    struct State: Sendable {
      var values: [String: String] = [:]
      var listeners: [String: [UUID: Listener]] = [:]
    }

    let state = Mutex(State())
  }

  private let id = UUID()
  private let document: Document

  public convenience init() { self.init(document: Document()) }

  private init(document: Document) { self.document = document }

  public func context() -> SharedStorage { SharedStorage(document: document) }

  public func get(_ key: String) -> String? { document.state.withLock { $0.values[key] } }

  public func set(_ key: String, _ value: String) { update(key) { _ in value } }

  public func delete(_ key: String) { update(key) { _ in nil } }

  public func update(_ key: String, _ change: @Sendable (String?) throws -> String?) rethrows {
    try document.state.withLock { state in
      let old = state.values[key]
      let value = try change(old)
      guard old != value else { return }
      state.values[key] = value
      for listener in state.listeners[key]?.values ?? [:].values where listener.context != id {
        listener.continuation.yield(value)
      }
    }
  }

  public func subscribe(_ key: String) -> AsyncStream<String?>? {
    let (stream, continuation) = AsyncStream<String?>.makeStream()
    let listener = UUID()
    document.state.withLock {
      $0.listeners[key, default: [:]][listener] = Listener(context: id, continuation: continuation)
    }
    continuation.onTermination = { [weak document] _ in
      document?.state.withLock {
        $0.listeners[key]?.removeValue(forKey: listener)
        if $0.listeners[key]?.isEmpty == true { $0.listeners.removeValue(forKey: key) }
      }
    }
    return stream
  }
}
