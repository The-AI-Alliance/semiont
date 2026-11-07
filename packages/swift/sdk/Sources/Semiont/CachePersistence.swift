import Foundation
import Synchronization

/// Where a client keeps its queries across a restart: a storage, and the prefix of what it keeps
/// there. A registry's session takes the knowledge base's id for its prefix.
public struct CachePersistence: Sendable {
  let storage: any SessionStorage
  let keyPrefix: String

  public init(storage: any SessionStorage, keyPrefix: String) {
    self.storage = storage
    self.keyPrefix = keyPrefix
  }

  func documentKey(_ name: String) -> String { "\(cacheKeyPrefix)\(keyPrefix).\(name)" }
}

/// The key of a kept query per nothing: `wholeKey`, and no other.
struct WholeKey: Codable, Hashable, Sendable {
  init() {}

  init(from decoder: any Decoder) throws {
    let container = try decoder.singleValueContainer()
    guard try container.decode(String.self) == wholeKey else {
      throw DecodingError.dataCorruptedError(
        in: container, debugDescription: "A query per nothing keeps its entry under \(wholeKey)")
    }
  }

  func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(wholeKey)
  }
}

/// A count of what is unsettled: settled when every begin has had its end.
final class Unsettled: Sendable {
  private let count = Mutex(0)

  func begin() { count.withLock { $0 += 1 } }
  func end() { count.withLock { $0 -= 1 } }
  var settled: Bool { count.withLock { $0 == 0 } }
}

/// Where a knowledge base's stream was, for each scope the last recorded event delivered on it,
/// kept under `lastEventIdKeyPrefix` and the persistence's prefix. A place heard is written only
/// in the same call as a kept cache's document, and only while nothing is `underway` and no save
/// is owed, so it never leads what the caches keep.
final class Places: Sendable {
  private struct State: Sendable {
    var waiting: [ResourceId: String] = [:]
    var closed = false
  }

  private let storage: any SessionStorage
  private let key: String
  private let underway: Unsettled
  private let saves: Unsettled
  private let state = Mutex(State())

  init(_ persistence: CachePersistence, underway: Unsettled, saves: Unsettled) {
    storage = persistence.storage
    key = lastEventIdKeyPrefix + persistence.keyPrefix
    self.underway = underway
    self.saves = saves
  }

  /// The places kept. A storage that cannot be read keeps none.
  var kept: [ResourceId: String] { Self.read(try? storage.get(key)) }

  /// Each pair that is a resource's id and a persisted event's id; none of a value that is no
  /// object.
  static func read(_ text: String?) -> [ResourceId: String] {
    guard let text,
      case .object(let pairs)? = try? JSONDecoder().decode(JSONValue.self, from: Data(text.utf8))
    else { return [:] }
    var places: [ResourceId: String] = [:]
    for (scope, place) in pairs {
      guard let resource = ResourceId.parse(scope), case .string(let id) = place,
        isPersistedEventId(id)
      else { continue }
      places[resource] = id
    }
    return places
  }

  func heard(_ id: String, in scope: ResourceId) {
    guard isPersistedEventId(id) else { return }
    state.withLock { state in
      if !state.closed { state.waiting[scope] = id }
    }
  }

  /// Called in the same call as each write of a kept cache's document.
  func written() {
    let places = state.withLock { state -> [ResourceId: String] in
      guard !state.closed, underway.settled, saves.settled else { return [:] }
      defer { state.waiting.removeAll() }
      return state.waiting
    }
    write(places)
  }

  /// Disposal's flush of the kept documents, once. The gate is read before anything is disposed,
  /// and the places it may write taken in the same step (B17): a fetch then under way or a refetch
  /// then owed holds them back, since disposal drops it; a save then owed does not, since the
  /// flush is that save; a place noted later is of an event whose refetch disposal drops.
  func close(flushing flush: () -> Void) {
    let taken = state.withLock { state -> (quiet: Bool, places: [ResourceId: String])? in
      guard !state.closed else { return nil }
      state.closed = true
      defer { state.waiting.removeAll() }
      return (underway.settled, state.waiting)
    }
    guard let taken else { return }
    flush()
    if taken.quiet, saves.settled { write(taken.places) }
  }

  private func write(_ places: [ResourceId: String]) {
    guard !places.isEmpty else { return }
    do {
      try storage.update(key) { stored in
        let merged = Self.read(stored).merging(places) { _, heard in heard }
        return try storedText(
          Dictionary(uniqueKeysWithValues: merged.map { ($0.key.value, $0.value) }))
      }
    } catch {
      // Keeping is optional: the places wait for the next write.
      state.withLock { state in
        if !state.closed { state.waiting.merge(places) { later, _ in later } }
      }
    }
  }
}

/// Whether `id` is a recorded event's: the one decider of what a stream's place may be.
func isPersistedEventId(_ id: String) -> Bool { faultOf(keptPlace, .string(id)) == nil }

/// What a client keeps across a restart: a document for each of `keptQueries`, closed together,
/// and where its stream was.
final class Keeping: Sendable {
  /// A kept cache's fetch under way, and a refetch a window of B19 owes.
  let underway: Unsettled
  let places: Places
  private let saves: Unsettled
  private let persistence: CachePersistence
  private let clock: any Clock<Duration>
  private let closers = Mutex<[@Sendable () -> Void]>([])

  init(_ persistence: CachePersistence, clock: any Clock<Duration>) {
    let underway = Unsettled()
    let saves = Unsettled()
    self.underway = underway
    self.saves = saves
    places = Places(persistence, underway: underway, saves: saves)
    self.persistence = persistence
    self.clock = clock
  }

  /// The persister of `query`'s document; none when the query is not kept.
  func persister<Key, Value>(_ query: CacheQuery) -> StoragePersister<Key, Value>? {
    guard keptQueries.contains(query) else { return nil }
    let persister = StoragePersister<Key, Value>(
      persistence, name: query.rawValue, underway: underway, saves: saves, places: places,
      clock: clock)
    closers.withLock { $0.append { persister.close() } }
    return persister
  }

  /// Flush every kept document, then the places if nothing was under way when this began.
  func close() {
    places.close { for close in closers.withLock({ $0 }) { close() } }
  }
}

/// One key of a kept query, and the persister that keeps it.
struct KeptValue<Value: Sendable>: Sendable {
  let underway: Unsettled
  let load: @Sendable () -> Value?
  let store: @Sendable (Value) -> Void
  let forget: @Sendable () -> Void

  init<Key>(book: StoragePersister<Key, Value>, key: Key) where Value: Codable {
    underway = book.underway
    load = { book.load(key) }
    store = { book.store(key, $0) }
    forget = { book.forget(key) }
  }
}

/// One query's kept document, under `cacheKeyPrefix`, the persistence's prefix, a dot and the
/// query's name: each key's value as the wire gave it, and when it was received. Any SDK reads
/// what another wrote (protocol/specs/src/session/stored.json `cacheDocument`).
public final class StoragePersister<Key, Value>: Sendable
where Key: Codable & Hashable & Sendable, Value: Codable & Sendable {
  private struct Entry: Sendable {
    let value: Value
    let keyText: String
    let valueText: String
    let stamp: Int64
  }

  private struct State: Sendable {
    var entries: [Key: Entry]
    var owed = false
    var saving: (id: UUID, task: Task<Void, Never>)?
    var closed = false
  }

  let underway: Unsettled
  private let saves: Unsettled
  private let storage: any SessionStorage
  private let key: String
  private let places: Places?
  private let clock: any Clock<Duration>
  private let state: Mutex<State>

  public convenience init(
    _ persistence: CachePersistence, name: String, clock: any Clock<Duration> = ContinuousClock()
  ) {
    self.init(
      persistence, name: name, underway: Unsettled(), saves: Unsettled(), places: nil,
      clock: clock)
  }

  init(
    _ persistence: CachePersistence, name: String, underway: Unsettled, saves: Unsettled,
    places: Places?, clock: any Clock<Duration>
  ) {
    let key = persistence.documentKey(name)
    self.underway = underway
    self.saves = saves
    storage = persistence.storage
    self.key = key
    self.places = places
    self.clock = clock
    // A storage that cannot be read keeps nothing.
    state = Mutex(State(entries: Self.read(try? persistence.storage.get(key))))
  }

  /// The entries of a stored document. A document whose structure is not a cache document's
  /// keeps nothing; an entry whose key or value is not this query's is skipped.
  private static func read(_ text: String?) -> [Key: Entry] {
    guard let text,
      case .object(let document)? = try? JSONDecoder().decode(
        JSONValue.self, from: Data(text.utf8)),
      document["version"] == .number(Double(cacheDocumentVersion)),
      case .array(let listed)? = document["entries"]
    else { return [:] }
    var rows: [(key: JSONValue, value: JSONValue, stamp: Int64)] = []
    for item in listed {
      guard case .array(let parts) = item, parts.count == 3, case .number(let at) = parts[2],
        let stamp = Int64(exactly: at), stamp >= 0
      else { return [:] }
      rows.append((parts[0], parts[1], stamp))
    }
    var entries: [Key: Entry] = [:]
    for row in rows {
      guard let key = try? decodedKept(Key.self, row.key),
        let value = try? decodedKept(Value.self, row.value),
        let keyText = try? keptText(key), let valueText = try? keptText(value)
      else { continue }
      entries[key] = Entry(value: value, keyText: keyText, valueText: valueText, stamp: row.stamp)
    }
    return entries
  }

  public var keys: [Key] { state.withLock { Array($0.entries.keys) } }
  var values: [Key: Value] { state.withLock { $0.entries.mapValues(\.value) } }

  public func load(_ key: Key) -> Value? { state.withLock { $0.entries[key]?.value } }

  /// Whether a save is owed or a fetch of its cache is under way: of this document's own cache, or,
  /// for a client's, of any of its kept caches.
  public var pending: Bool {
    !state.withLock { $0.closed } && !(underway.settled && saves.settled)
  }

  /// Keep `value` as `key`'s. A value received again unchanged keeps the time it was first
  /// received.
  public func store(_ key: Key, _ value: Value) {
    guard let keyText = try? keptText(key), let valueText = try? keptText(value) else { return }
    state.withLock { state in
      guard !state.closed else { return }
      var stamp = epochMilliseconds()
      if let kept = state.entries[key], kept.valueText == valueText { stamp = kept.stamp }
      state.entries[key] = Entry(
        value: value, keyText: keyText, valueText: valueText, stamp: stamp)
      owe(&state)
    }
  }

  /// Keep nothing of `key`, whose value is gone.
  func forget(_ key: Key) {
    state.withLock { state in
      guard !state.closed, state.entries.removeValue(forKey: key) != nil else { return }
      owe(&state)
    }
  }

  private func owe(_ state: inout State) {
    if !state.owed {
      state.owed = true
      saves.begin()
    }
    state.saving?.task.cancel()
    let id = UUID()
    let clock = clock
    state.saving = (
      id,
      Task { [weak self] in
        guard (try? await sleepMilliseconds(Timings.saveDebounceMs, on: clock)) != nil else {
          return
        }
        self?.save(id)
      }
    )
  }

  private func save(_ id: UUID) {
    state.withLock { state in
      guard state.saving?.id == id else { return }
      state.saving = nil
      if !state.closed { write(&state) }
    }
  }

  public func close() {
    state.withLock { state in
      guard !state.closed else { return }
      state.saving?.task.cancel()
      state.saving = nil
      write(&state)
      state.closed = true
    }
  }

  deinit { close() }

  private func write(_ state: inout State) {
    guard state.owed else { return }
    do {
      try storage.set(key, document(state.entries))
    } catch {
      // Keeping is optional: the save stays owed, for the next change or disposal.
      return
    }
    state.owed = false
    saves.end()
    places?.written()
  }

  /// The document's text, less the entries received longest ago while it is larger than
  /// `maxStoredBytesCount`.
  private func document(_ entries: [Key: Entry]) -> String {
    let rows = entries.values.sorted { $0.stamp > $1.stamp }.map {
      "[\($0.keyText),\($0.valueText),\($0.stamp)]"
    }
    let head = "{\"version\":\(cacheDocumentVersion),\"entries\":["
    let tail = "]}"
    var kept = rows.count
    var size =
      head.utf8.count + tail.utf8.count + rows.reduce(0) { $0 + $1.utf8.count } + max(kept - 1, 0)
    while size > Timings.maxStoredBytesCount, kept > 0 {
      kept -= 1
      size -= rows[kept].utf8.count + (kept > 0 ? 1 : 0)
    }
    return head + rows.prefix(kept).joined(separator: ",") + tail
  }
}

/// The JSON a key or a value is kept as: its members in order and its slashes as they are, so one
/// value is always one text.
private func keptText<Kept: Encodable>(_ kept: Kept) throws -> String {
  let encoder = JSONEncoder()
  encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
  return String(decoding: try encoder.encode(kept), as: UTF8.self)
}

private func decodedKept<Kept: Decodable>(_ type: Kept.Type, _ value: JSONValue) throws -> Kept {
  try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
}

/// Milliseconds since the Unix epoch, by the wall clock.
private func epochMilliseconds() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
