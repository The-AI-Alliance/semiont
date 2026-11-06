import Foundation
import Synchronization

/// Where a client keeps the answers of the queries protocol/specs/src/client/refresh.json marks
/// `persisted`, and where its stream was: in `storage`, under the keys of the knowledge base `kbId`
/// and of the person whose key is `personKey` (``personKey(_:)``, and
/// protocol/specs/src/session/stored.json). The client reads what is kept for them as it is made.
public struct CachePersistence: Sendable {
  let storage: any SessionStorage
  let kbId: String
  /// The key of the person kept for: none until the gateway names them, when the session attaches it.
  let person: String?
  /// The sign-in is kept beside the caches, under `sessionKey(kbId)`, and every write first checks
  /// that it still names `person`.
  let followsSignIn: Bool

  public init(storage: any SessionStorage, kbId: String, personKey: String) {
    self.init(storage: storage, kbId: kbId, person: personKey, followsSignIn: false)
  }

  init(storage: any SessionStorage, kbId: String, person: String?, followsSignIn: Bool) {
    self.storage = storage
    self.kbId = kbId
    self.person = person
    self.followsSignIn = followsSignIn
  }
}

/// The reads a persisted query has in flight: while any is, what it holds may be older than an
/// event already heard (B17-Q).
protocol CacheWork: Sendable {
  func begin()
  func end()
}

/// How one entry of a persisted query reads, and writes, what is kept of it.
struct KeptValue<Value: Sendable>: Sendable {
  let book: any CacheWork
  let load: @Sendable () -> Value?
  let store: @Sendable (Value?) -> Void

  init<Key>(book: StoragePersister<Key>, key: Key) where Value: Codable {
    self.book = book
    self.load = { book.load(key, as: Value.self) }
    self.store = { book.store(key, $0) }
  }

  init<Key: Encodable & Sendable>(keeping: KeptQueries, query: KeptQuery, key: Key)
  where Value: Codable {
    self.book = keeping
    self.load = { keeping.load(query, key, as: Value.self) }
    self.store = { keeping.store(query, key, $0) }
  }
}

/// One query's values, kept in `storage` under `storageKey` as one document, the shape
/// protocol/specs/src/session/stored.json's `cacheKeyPrefix` gives: a new value is written
/// `saveDebounceMs` after the last, by `clock`, and what is not yet written when it is closed.
public final class StoragePersister<Key: Codable & Hashable & Sendable>: CacheWork {
  private struct State: Sendable {
    var document: KeptDocument
    var changed = false
    var timer = SaveTimer()
    var work = 0
    var closed = false
  }

  private let storage: any SessionStorage
  private let storageKey: String
  private let clock: any Clock<Duration>
  private let state: Mutex<State>

  public init(
    storage: any SessionStorage, storageKey: String,
    clock: any Clock<Duration> = ContinuousClock()
  ) {
    self.storage = storage
    self.storageKey = storageKey
    self.clock = clock
    // A document that cannot be read is nothing kept.
    state = Mutex(State(document: KeptDocument(try? storage.get(storageKey))))
  }

  public var keys: [Key] { state.withLock { $0.document }.keys(as: Key.self) }

  public func load<Value: Decodable>(_ key: Key, as type: Value.Type) -> Value? {
    state.withLock { $0.document }.value(key, as: type)
  }

  func begin() { state.withLock { if !$0.closed { $0.work += 1 } } }
  func end() { state.withLock { if !$0.closed { $0.work -= 1 } } }

  /// Whether what it holds may be newer than what is written: a read in flight, or a write not
  /// yet made.
  public var pending: Bool { state.withLock { !$0.closed && ($0.work != 0 || $0.changed) } }

  public func store<Value: Encodable>(_ key: Key, _ value: Value?) {
    state.withLock { state in
      guard !state.closed else { return }
      state.document.set(key, value, at: millisecondsNow())
      state.changed = true
      state.timer.restart(on: clock) { [weak self] id in self?.saved(id) }
    }
  }

  public func close() {
    state.withLock { state in
      guard !state.closed else { return }
      state.timer.stop()
      flush(&state)
      state.closed = true
    }
  }

  deinit { close() }

  private func saved(_ id: UUID) {
    state.withLock { state in
      if state.timer.fire(id), !state.closed { flush(&state) }
    }
  }

  private func flush(_ state: inout State) {
    guard state.changed else { return }
    do {
      try storage.set(storageKey, state.document.text(at: millisecondsNow()))
      state.changed = false
    } catch {
      // Keeping is optional: what was not written is written with the next save, or the close.
    }
  }
}

/// What a client keeps of one person on one knowledge base: each persisted query's document, and
/// the stream's places, under that person's keys. It reads and writes nothing until it is attached
/// for a person, and nothing again once a write finds that the sign-in it follows names no one, or
/// someone else.
final class KeptQueries: CacheWork {
  private struct Attached: Sendable {
    let person: String
    var documents: [KeptQuery: KeptDocument]
    var changed: Set<KeptQuery> = []
    var places: [ResourceId: String] = [:]
  }

  private struct State: Sendable {
    var attached: Attached?
    var work = 0
    var timer = SaveTimer()
    var ended = false
  }

  private let storage: any SessionStorage
  private let kbId: String
  private let followsSignIn: Bool
  private let clock: any Clock<Duration>
  private let state = Mutex(State())

  init(_ persistence: CachePersistence, clock: any Clock<Duration>) {
    storage = persistence.storage
    kbId = persistence.kbId
    followsSignIn = persistence.followsSignIn
    self.clock = clock
  }

  /// Starts keeping for the person `person`, and gives the stream places kept for them; nil when
  /// it keeps already, or has stopped.
  func attach(_ person: String) -> [ResourceId: String]? {
    state.withLock { state in
      guard !state.ended, state.attached == nil else { return nil }
      // A document that cannot be read is nothing kept.
      let documents = Dictionary(
        uniqueKeysWithValues: KeptQuery.allCases.map { query in
          (query, KeptDocument(try? storage.get(cacheKey(kbId, person, query))))
        })
      state.attached = Attached(person: person, documents: documents)
      return storedPlaces(try? storage.get(lastEventIdKey(kbId, person)))
    }
  }

  func keys<Key: Decodable>(_ query: KeptQuery, as type: Key.Type) -> [Key] {
    guard let document = state.withLock({ $0.attached?.documents[query] }) else { return [] }
    return document.keys(as: type)
  }

  func load<Key: Encodable, Value: Decodable>(
    _ query: KeptQuery, _ key: Key, as type: Value.Type
  ) -> Value? {
    state.withLock { $0.attached?.documents[query] }?.value(key, as: type)
  }

  func store<Key: Encodable, Value: Encodable>(_ query: KeptQuery, _ key: Key, _ value: Value?) {
    state.withLock { state in
      guard state.attached != nil else { return }
      state.attached?.documents[query]?.set(key, value, at: millisecondsNow())
      state.attached?.changed.insert(query)
      state.timer.restart(on: clock) { [weak self] id in self?.saved(id) }
    }
  }

  func heard(_ id: String, in scope: ResourceId) {
    guard id.hasPrefix("p-") else { return }
    state.withLock { $0.attached?.places[scope] = id }
  }

  func begin() { state.withLock { $0.work += 1 } }
  func end() { state.withLock { $0.work -= 1 } }

  func close() {
    state.withLock { state in
      state.timer.stop()
      flush(&state)
      state.attached = nil
      state.ended = true
    }
  }

  deinit { close() }

  private func saved(_ id: UUID) {
    state.withLock { state in
      if state.timer.fire(id) { flush(&state) }
    }
  }

  /// Writes each changed document and then, while no persisted query has a read in flight, the
  /// stream's places: so they may lag the documents, and never lead them (B17-Q).
  private func flush(_ state: inout State) {
    guard let attached = state.attached, !attached.changed.isEmpty else { return }
    do {
      if followsSignIn, try storedSession(storage, kbId: kbId)?.personKey != attached.person {
        state.timer.stop()
        state.attached = nil
        state.ended = true
        return
      }
      let now = millisecondsNow()
      for query in KeptQuery.allCases where attached.changed.contains(query) {
        guard let text = state.attached?.documents[query]?.text(at: now) else { continue }
        try storage.set(cacheKey(kbId, attached.person, query), text)
        state.attached?.changed.remove(query)
      }
      let places = attached.places
      guard state.work == 0, !places.isEmpty else { return }
      try storage.update(lastEventIdKey(kbId, attached.person)) { text in
        let merged = storedPlaces(text).merging(places) { _, heard in heard }
        return try storedText(
          Dictionary(uniqueKeysWithValues: merged.map { scope, id in (scope.value, id) }))
      }
      state.attached?.places.removeAll()
    } catch {
      // Keeping is optional: what was not written is written with the next save, or the close.
    }
  }
}

/// The stream places `text` keeps: a JSON object from a resource's id to the id of the last
/// recorded event delivered on it.
private func storedPlaces(_ text: String?) -> [ResourceId: String] {
  guard let stored = decodedStorage([String: String].self, text) else { return [:] }
  var places: [ResourceId: String] = [:]
  for (scope, id) in stored {
    if let resource = ResourceId.parse(scope) { places[resource] = id }
  }
  return places
}

/// One query's kept values, as the document its key holds:
/// `{"version":1,"writtenAt":<ms>,"entries":[[<key>,<value>,<ms>],…]}`, each key and value as
/// JSON, and each value with when it last changed.
struct KeptDocument: Sendable {
  private static let version = 1
  private var entries: [String: (value: String, writtenAt: Int64)] = [:]

  /// What `text` keeps: nothing when there is none, or it is of another version, or it does not
  /// parse.
  init(_ text: String?) {
    guard case .object(let document)? = decodedStorage(JSONValue.self, text),
      document["version"] == .number(Double(Self.version)),
      case .array(let stored)? = document["entries"]
    else { return }
    for entry in stored {
      // An entry of another shape is not kept.
      guard case .array(let parts) = entry, parts.count == 3,
        case .number(let stamp) = parts[2], let writtenAt = Int64(exactly: stamp),
        let key = try? keptText(parts[0]), let value = try? keptText(parts[1])
      else { continue }
      entries[key] = (value, writtenAt)
    }
  }

  // A key or value that cannot be written as JSON, or read back as its type, is not kept.

  func keys<Key: Decodable>(as type: Key.Type) -> [Key] {
    entries.keys.compactMap { try? JSONDecoder().decode(type, from: Data($0.utf8)) }
  }

  func value<Key: Encodable, Value: Decodable>(_ key: Key, as type: Value.Type) -> Value? {
    guard let key = try? keptText(key), let entry = entries[key] else { return nil }
    return try? JSONDecoder().decode(type, from: Data(entry.value.utf8))
  }

  mutating func set<Key: Encodable, Value: Encodable>(_ key: Key, _ value: Value?, at now: Int64) {
    guard let key = try? keptText(key) else { return }
    guard let value else {
      entries[key] = nil
      return
    }
    guard let text = try? keptText(value), entries[key]?.value != text else { return }
    entries[key] = (text, now)
  }

  /// The document as written at `now`: the values longest unchanged go, and are kept no more,
  /// until it fits within `maxStoredBytesCount`.
  mutating func text(at now: Int64) -> String {
    let head = "{\"version\":\(Self.version),\"writtenAt\":\(now),\"entries\":["
    let tail = "]}"
    let written = entries.sorted { ($0.value.writtenAt, $0.key) < ($1.value.writtenAt, $1.key) }
      .map { (key: $0.key, text: "[\($0.key),\($0.value.value),\($0.value.writtenAt)]") }
    var size =
      head.utf8.count + tail.utf8.count + written.reduce(0) { $0 + $1.text.utf8.count }
      + max(written.count - 1, 0)
    var evicted = 0
    while evicted < written.count, size > Timings.maxStoredBytesCount {
      size -= written[evicted].text.utf8.count + (evicted < written.count - 1 ? 1 : 0)
      entries[written[evicted].key] = nil
      evicted += 1
    }
    return head + written.dropFirst(evicted).map(\.text).joined(separator: ",") + tail
  }
}

/// `value` as the JSON a kept document holds: keys sorted and slashes plain, so a key read back
/// from storage is spelled as one made in memory.
private func keptText(_ value: some Encodable) throws -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  return String(decoding: try encoder.encode(value), as: UTF8.self)
}

private func millisecondsNow() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

/// A write that waits `saveDebounceMs` after the last change, by its clock.
struct SaveTimer: Sendable {
  private var waiting: (id: UUID, task: Task<Void, Never>)?

  mutating func restart(on clock: any Clock<Duration>, _ due: @escaping @Sendable (UUID) -> Void) {
    waiting?.task.cancel()
    let id = UUID()
    waiting = (
      id,
      Task {
        guard (try? await sleepMilliseconds(Timings.saveDebounceMs, on: clock)) != nil else {
          return
        }
        due(id)
      }
    )
  }

  /// Whether `id` is the write waited for; after this it is waited for no more.
  mutating func fire(_ id: UUID) -> Bool {
    guard waiting?.id == id else { return false }
    waiting = nil
    return true
  }

  mutating func stop() {
    waiting?.task.cancel()
    waiting = nil
  }
}
