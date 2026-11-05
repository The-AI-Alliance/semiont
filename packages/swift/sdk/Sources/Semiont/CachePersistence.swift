import Foundation
import Synchronization

public struct CachePersistence: Sendable {
  let storage: any SessionStorage
  let keyPrefix: String

  public init(storage: any SessionStorage, keyPrefix: String) {
    self.storage = storage
    self.keyPrefix = keyPrefix
  }
}

enum KeptQuery: Hashable, Codable, Sendable {
  case resource(ResourceId)
  case annotations(ResourceId)
  case annotation(ResourceId, AnnotationId)
  case entityTypes
  case tagSchemas
}

protocol CacheWork: Sendable {
  func begin()
  func end()
}

struct KeptValue<Value: Sendable>: Sendable {
  let book: any CacheWork
  let load: @Sendable () -> Value?
  let store: @Sendable (Value?) -> Void

  init<Key>(book: StoragePersister<Key>, key: Key) where Value: Codable {
    self.book = book
    self.load = { book.load(key, as: Value.self) }
    self.store = { book.store(key, $0) }
  }
}

/// Bookmarks and their settled values are committed together in one storage update.
public final class StoragePersister<Key: Codable & Hashable & Sendable>: CacheWork {
  private struct Entry: Codable, Sendable {
    let value: Data
    let age: UInt64
  }

  private struct Document: Codable, Sendable {
    var version = 1
    var entries: [Key: Entry] = [:]
    var bookmarks: [ResourceId: String] = [:]
  }

  private struct State: Sendable {
    var document: Document
    var age: UInt64
    var changes: Set<Key> = []
    var pendingBookmarks: [ResourceId: String] = [:]
    var work = 0
    var saving: Task<Void, Never>?
    var closed = false
  }

  private let config: CachePersistence
  private let storageKey: String
  private let state: Mutex<State>

  public init(_ config: CachePersistence) {
    let storageKey = "semiont.cache.\(config.keyPrefix).swift"
    let saved = Self.decode(try? config.storage.get(storageKey))
    self.config = config
    self.storageKey = storageKey
    self.state = Mutex(State(document: saved, age: saved.entries.values.map(\.age).max() ?? 0))
  }

  private static func decode(_ text: String?) -> Document {
    guard let text,
      let value = try? JSONDecoder().decode(Document.self, from: Data(text.utf8)),
      value.version == Document().version
    else { return Document() }
    return value
  }

  public var keys: [Key] { state.withLock { Array($0.document.entries.keys) } }
  var bookmarks: [ResourceId: String] { state.withLock { $0.document.bookmarks } }

  public func load<Value: Decodable>(_ key: Key, as type: Value.Type) -> Value? {
    guard let data = state.withLock({ $0.document.entries[key]?.value }) else { return nil }
    return try? JSONDecoder().decode(type, from: data)
  }

  func begin() { state.withLock { if !$0.closed { $0.work += 1 } } }
  func end() { state.withLock { if !$0.closed { $0.work -= 1 } } }

  public var pending: Bool {
    state.withLock { !$0.closed && ($0.work != 0 || $0.saving != nil || !$0.changes.isEmpty) }
  }

  func heard(_ id: String, in scope: ResourceId) {
    guard id.hasPrefix("p-") else { return }
    state.withLock { state in
      if !state.closed { state.pendingBookmarks[scope] = id }
    }
  }

  public func store<Value: Encodable>(_ key: Key, _ value: Value?) {
    let encoded: Data?
    if let value {
      guard let data = try? JSONEncoder().encode(value) else { return }
      encoded = data
    } else {
      encoded = nil
    }
    state.withLock { state in
      guard !state.closed else { return }
      state.age += 1
      state.document.entries[key] = encoded.map { Entry(value: $0, age: state.age) }
      state.changes.insert(key)
      guard state.saving == nil else { return }
      state.saving = Task { [weak self] in
        guard (try? await sleepMilliseconds(Timings.saveDebounceMs)) != nil else { return }
        self?.save()
      }
    }
  }

  private func save() {
    state.withLock { state in
      state.saving = nil
      if !state.closed { flush(&state) }
    }
  }

  public func close() {
    state.withLock { state in
      guard !state.closed else { return }
      state.saving?.cancel()
      state.saving = nil
      flush(&state)
      state.closed = true
    }
  }

  deinit { close() }

  private func flush(_ state: inout State) {
    guard !state.changes.isEmpty else { return }
    let changed = state.changes
    let snapshot = state.document
    let bookmarks = state.work == 0 ? state.pendingBookmarks : [:]
    do {
      try config.storage.update(storageKey) { old in
        var document = Self.decode(old)
        var age = document.entries.values.map(\.age).max() ?? 0
        for key in changed.sorted(by: {
          (snapshot.entries[$0]?.age ?? 0) < (snapshot.entries[$1]?.age ?? 0)
        }) {
          age += 1
          document.entries[key] = snapshot.entries[key].map { Entry(value: $0.value, age: age) }
        }
        // A bookmark belongs to this client's view of the values. Do not advance it
        // across another writer's changes or an invalidation still being processed.
        document.bookmarks =
          document.entries.mapValues(\.value) == snapshot.entries.mapValues(\.value)
          ? snapshot.bookmarks.merging(bookmarks) { _, incoming in incoming } : [:]
        let encoder = JSONEncoder()
        var encoded = try encoder.encode(document)
        for oldest in document.entries.sorted(by: { $0.value.age < $1.value.age })
        where encoded.count > Timings.maxStoredBytesCount {
          document.entries.removeValue(forKey: oldest.key)
          encoded = try encoder.encode(document)
        }
        if encoded.count > Timings.maxStoredBytesCount {
          document.bookmarks.removeAll()
          encoded = try encoder.encode(document)
        }
        return String(decoding: encoded, as: UTF8.self)
      }
      state.changes.removeAll()
      if state.work == 0 {
        state.document.bookmarks.merge(bookmarks) { _, incoming in incoming }
        state.pendingBookmarks.removeAll()
      }
    } catch {
      // Keeping the cache is optional. Retry on the next changed value or disposal.
    }
  }
}
