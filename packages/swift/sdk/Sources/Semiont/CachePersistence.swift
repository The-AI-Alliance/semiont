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
  /// How the client writes what it keeps.
  let writer: any KeptWriter

  public init(storage: any SessionStorage, kbId: String, personKey: String) {
    self.init(storage: storage, kbId: kbId, person: personKey, writer: WritesAsGiven())
  }

  init(storage: any SessionStorage, kbId: String, person: String?, writer: any KeptWriter) {
    self.storage = storage
    self.kbId = kbId
    self.person = person
    self.writer = writer
  }
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

/// Whether `id` is a recorded event's: the one decider of what a stream's place may be.
func isPersistedEventId(_ id: String) -> Bool { faultOf(keptPlace, .string(id)) == nil }

/// How one entry of a persisted query reads, and writes, what is kept of it.
struct KeptValue<Value: Sendable>: Sendable {
  /// A fetch of its cache under way, and a refetch a window of B19 owes: while any is, what it
  /// holds may be older than an event already heard (B17).
  let underway: Unsettled
  let load: @Sendable () -> Value?
  let store: @Sendable (Value) -> Void
  /// Keeps nothing of its key, whose value is gone.
  let forget: @Sendable () -> Void

  init<Key>(book: StoragePersister<Key, Value>, key: Key) where Value: Codable {
    underway = book.underway
    load = { book.load(key) }
    store = { book.store(key, $0) }
    forget = { book.store(key, nil) }
  }

  init<Key: Encodable & Sendable>(keeping: KeptQueries, query: KeptQuery, key: Key)
  where Value: Codable {
    underway = keeping.underway
    load = { keeping.load(query, key, as: Value.self) }
    store = { keeping.store(query, key, $0) }
    forget = { keeping.store(query, key, Value?.none) }
  }
}

/// One cache's values, kept in `storage` under `storageKey` as one document, the form
/// protocol/specs/src/session/stored.json's `cacheDocument` gives: a new value is written
/// `saveDebounceMs` after the last, by `clock`, and what is not yet written when it is closed. It
/// skips an entry kept under a key that is not a `Key`, or with a value that is not a `Value`.
public final class StoragePersister<Key, Value>: Sendable
where Key: Codable & Hashable & Sendable, Value: Codable & Sendable {
  private struct State: Sendable {
    var document: KeptDocument
    var owed = false
    var timer = SaveTimer()
    var closed = false
  }

  /// A fetch of its cache under way, and a refetch a window of B19 owes.
  let underway = Unsettled()
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
    state = Mutex(
      State(
        document: KeptDocument(try? storage.get(storageKey), keys: Key.self, values: Value.self)))
  }

  public var keys: [Key] { state.withLock { $0.document }.keys(as: Key.self) }

  public func load(_ key: Key) -> Value? {
    state.withLock { $0.document }.value(key, as: Value.self)
  }

  /// Whether what it holds may be newer than what is written: a save owed, or a fetch of its
  /// cache under way.
  public var pending: Bool {
    let (closed, owed) = state.withLock { ($0.closed, $0.owed) }
    return !closed && (owed || !underway.settled)
  }

  /// Keeps `value` as `key`'s, and nothing of `key` when it is nil.
  public func store(_ key: Key, _ value: Value?) {
    state.withLock { state in
      guard !state.closed else { return }
      state.document.set(key, value, at: millisecondsNow())
      state.owed = true
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
    guard state.owed else { return }
    do {
      try storage.set(storageKey, state.document.text())
      state.owed = false
    } catch {
      // Keeping is optional: the save stays owed, for the next change or the close.
    }
  }
}

/// What a client keeps of one person on one knowledge base: each persisted query's document, and
/// the stream's places, under that person's keys. It reads and writes nothing until it is attached
/// for a person, and its writer (``KeptWriter``) says how and when it writes. Each document is
/// saved `saveDebounceMs` after its own last change.
final class KeptQueries: Sendable {
  private struct Attached: Sendable {
    let person: String
    var documents: [KeptQuery: KeptDocument]
    /// The documents that owe a save: changed since they were last written.
    var owed: Set<KeptQuery> = []
    var places: [ResourceId: String] = [:]
  }

  private struct State: Sendable {
    var attached: Attached?
    var saves: [KeptQuery: SaveTimer] = [:]
    /// It takes no new value: its client is closing.
    var closed = false
    /// It writes nothing more: it has closed, or its sign-in no longer names its person.
    var ended = false
  }

  /// What one write puts in storage: each document's text, and the stream's places.
  fileprivate struct Writing: Sendable {
    let person: String
    let documents: [(KeptQuery, String)]
    var places: [ResourceId: String]
  }

  /// A kept cache's fetch under way, and a refetch a window of B19 owes, of any of its client's
  /// caches.
  let underway = Unsettled()
  private let storage: any SessionStorage
  fileprivate let kbId: String
  private let writer: any KeptWriter
  private let clock: any Clock<Duration>
  private let state = Mutex(State())

  init(_ persistence: CachePersistence, clock: any Clock<Duration>) {
    storage = persistence.storage
    kbId = persistence.kbId
    writer = persistence.writer
    self.clock = clock
  }

  /// Starts keeping for the person `person`, and gives the stream places kept for them; nil when
  /// it keeps already, or has stopped.
  func attach(_ person: String) -> [ResourceId: String]? {
    state.withLock { state in
      guard !state.ended, !state.closed, state.attached == nil else { return nil }
      // A document that cannot be read is nothing kept.
      let documents = Dictionary(
        uniqueKeysWithValues: KeptQuery.allCases.map { query in
          (query, query.document(try? storage.get(cacheKey(kbId, person, query))))
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

  /// Makes `query`'s document hold `value` as `key`'s, and nothing of `key` when it is nil, owing
  /// no save: the save of the document's next change writes it (B17: attaching writes nothing).
  func absorb<Key: Encodable, Value: Encodable>(_ query: KeptQuery, _ key: Key, _ value: Value?) {
    state.withLock { state in
      guard !state.closed else { return }
      state.attached?.documents[query]?.set(key, value, at: millisecondsNow())
    }
  }

  /// Keeps `value` as `key`'s in `query`'s document, and nothing of `key` when it is nil.
  func store<Key: Encodable, Value: Encodable>(_ query: KeptQuery, _ key: Key, _ value: Value?) {
    state.withLock { state in
      guard state.attached != nil, !state.closed else { return }
      state.attached?.documents[query]?.set(key, value, at: millisecondsNow())
      state.attached?.owed.insert(query)
      state.saves[query, default: SaveTimer()].restart(on: clock) { [weak self] id in
        self?.saved(query, id)
      }
    }
  }

  func heard(_ id: String, in scope: ResourceId) {
    guard isPersistedEventId(id) else { return }
    state.withLock { state in
      if !state.closed { state.attached?.places[scope] = id }
    }
  }

  /// Whether what it holds may be newer than what is written: a save owed, a write the storage
  /// refused among them, or a kept cache's fetch under way or refetch owed.
  var pending: Bool {
    let (closed, owing) = state.withLock { ($0.closed, $0.attached?.owed.isEmpty == false) }
    return !closed && (owing || !underway.settled)
  }

  /// Takes no new value, and writes what is not yet written as its writer writes.
  func close() { writer.close(self) }

  /// Waits until every write begun so far has landed: once it is closed, until its last.
  func closed() async { await writer.closed() }

  private func saved(_ query: KeptQuery, _ id: UUID) {
    guard state.withLock({ $0.saves[query]?.fire(id) == true }) else { return }
    writer.save(self, query)
  }

  // What its writers do with it.

  /// What `query`'s document has not yet written, taken to be written; nil when there is none, or
  /// it writes no more.
  fileprivate func take(_ query: KeptQuery) -> Writing? {
    state.withLock { taken(&$0, of: [query]) }
  }

  /// Whether it writes nothing more.
  fileprivate var ended: Bool { state.withLock { $0.ended } }

  /// Writes what `query`'s document has not yet written at once, while nothing it holds changes.
  fileprivate func writeNow(_ query: KeptQuery) {
    state.withLock { state in
      guard let writing = taken(&state, of: [query]), let unwritten = put(writing) else { return }
      Self.restore(&state, unwritten)
    }
  }

  /// Takes no new value, writes what is not yet written at once, and keeps nothing more.
  fileprivate func closeNow() {
    state.withLock { state in
      guard !state.closed else { return }
      state.closed = true
      Self.stopSaves(&state)
      // What the close cannot write is kept no more.
      if let writing = taken(&state, of: Set(KeptQuery.allCases)) { put(writing) }
      state.attached = nil
      state.ended = true
    }
  }

  /// Takes no new value, and gives what is not yet written; `closing` is false when it was closed
  /// already.
  fileprivate func stopTaking() -> (closing: Bool, writing: Writing?) {
    state.withLock { state in
      guard !state.closed else { return (false, nil) }
      state.closed = true
      Self.stopSaves(&state)
      return (true, taken(&state, of: Set(KeptQuery.allCases)))
    }
  }

  /// Writes `writing`, taken before, and keeps what it could not write to be written again. A
  /// document a write since could not put still owes its save, and holds the places back (B17).
  fileprivate func write(_ writing: Writing) {
    var writing = writing
    let owing = state.withLock { state in
      guard state.attached?.owed.isEmpty == false else { return false }
      state.attached?.places.merge(writing.places) { heard, _ in heard }
      return true
    }
    if owing { writing.places = [:] }
    guard let unwritten = put(writing) else { return }
    state.withLock { Self.restore(&$0, unwritten) }
  }

  /// Its sign-in is not known to name its person: what is not yet written goes, and nothing is
  /// written again.
  fileprivate func drop() {
    state.withLock { state in
      Self.stopSaves(&state)
      state.attached = nil
      state.ended = true
    }
  }

  /// Its client has closed: it keeps nothing more.
  fileprivate func finish() {
    state.withLock { state in
      state.attached = nil
      state.ended = true
    }
  }

  /// Puts `writing` in storage, and gives what it could not put: nil when it put everything.
  @discardableResult
  private func put(_ writing: Writing) -> Writing? {
    var written = 0
    do {
      for (query, text) in writing.documents {
        try storage.set(cacheKey(kbId, writing.person, query), text)
        written += 1
      }
      guard !writing.places.isEmpty else { return nil }
      try storage.update(lastEventIdKey(kbId, writing.person)) { text in
        let merged = storedPlaces(text).merging(writing.places) { _, heard in heard }
        return try storedText(
          Dictionary(uniqueKeysWithValues: merged.map { scope, id in (scope.value, id) }))
      }
      return nil
    } catch {
      // Keeping is optional: what was not written is written with the next save, or the close.
      return Writing(
        person: writing.person, documents: Array(writing.documents.dropFirst(written)),
        places: writing.places)
    }
  }

  /// What a write did not put in storage owes its save again; a place heard since stays.
  private static func restore(_ state: inout State, _ unwritten: Writing) {
    state.attached?.owed.formUnion(unwritten.documents.map { $0.0 })
    state.attached?.places.merge(unwritten.places) { heard, _ in heard }
  }

  private static func stopSaves(_ state: inout State) {
    for query in KeptQuery.allCases { state.saves[query]?.stop() }
  }

  /// What `queries`' documents have not yet written, taken to be written, and the stream's places
  /// while the gate is open (B17): no kept cache's fetch under way, no refetch owed, and no other
  /// document owing a save. So the places may lag the documents and never lead them; a close
  /// takes every document, its flush being every save owed.
  private func taken(_ state: inout State, of queries: Set<KeptQuery>) -> Writing? {
    guard !state.ended, var attached = state.attached else { return nil }
    let due = attached.owed.intersection(queries)
    guard !due.isEmpty else { return nil }
    var documents: [(KeptQuery, String)] = []
    for query in KeptQuery.allCases where due.contains(query) {
      guard let text = attached.documents[query]?.text() else { continue }
      documents.append((query, text))
    }
    attached.owed.subtract(due)
    var places: [ResourceId: String] = [:]
    if attached.owed.isEmpty, underway.settled { swap(&places, &attached.places) }
    state.attached = attached
    return Writing(person: attached.person, documents: documents, places: places)
  }
}

/// How a client's keeping writes what it holds: ``WritesAsGiven`` for a client an app wires itself
/// with a ``CachePersistence``, ``WritesWhileNamed`` for the client of a session an SDK's builder
/// makes.
protocol KeptWriter: Sendable {
  /// Writes what `query`'s document of `keeping` has not yet written, its save being due.
  func save(_ keeping: KeptQueries, _ query: KeptQuery)
  /// Writes what `keeping` has not yet written as its client closes; it keeps nothing after.
  func close(_ keeping: KeptQueries)
  /// Waits until every write it has begun has landed.
  func closed() async
}

/// The writer of a client an app wires itself: it writes as it is given, at once, so a client has
/// written everything when its closing returns. It asks no sign-in anything: no session of the
/// SDK's holds one for that client.
struct WritesAsGiven: KeptWriter {
  func save(_ keeping: KeptQueries, _ query: KeptQuery) { keeping.writeNow(query) }
  func close(_ keeping: KeptQueries) { keeping.closeNow() }
  func closed() async {}
}

/// The writer of the client of a session an SDK's builder makes. It writes in steps that run one at
/// a time (``SerialSteps``): each asks what holds the session's sign-in whether it still names the
/// person kept for, and writes only while it does, with no other step between; the session's
/// forgetting of its sign-in is a step too, after which nothing is written, so no save lands after
/// what forgetting deletes, within one process. A sign-in that is gone, or names nobody or someone
/// else, drops what is not yet written, and nothing is written again. So does one that cannot be
/// read, which is reported once, as a ``SessionError`` of `session.keep-failed`.
final class WritesWhileNamed: KeptWriter {
  private let kept: any SignInKept
  private let report: @Sendable (SessionError) async -> Void
  private let steps = SerialSteps()
  private let forgotten = Mutex(false)

  init(kept: any SignInKept, report: @escaping @Sendable (SessionError) async -> Void) {
    self.kept = kept
    self.report = report
  }

  func save(_ keeping: KeptQueries, _ query: KeptQuery) {
    steps.then { [weak keeping, self] in
      guard let keeping, let writing = keeping.take(query) else { return }
      await write(writing, of: keeping)
    }
  }

  func close(_ keeping: KeptQueries) {
    let (closing, writing) = keeping.stopTaking()
    guard closing else { return }
    steps.then { [self] in
      if let writing { await write(writing, of: keeping) }
      keeping.finish()
    }
  }

  func closed() async { await steps.drained() }

  /// Runs `forget`, the session's forgetting of its sign-in, once every write begun before it has
  /// landed; nothing is written after it.
  func forgetting(_ forget: @escaping @Sendable () async throws -> Void) async throws {
    try await steps.then { [self] in
      forgotten.withLock { $0 = true }
      try await forget()
    }.value
  }

  /// Writes `writing`, taken before this step began, unless it was dropped since.
  private func write(_ writing: KeptQueries.Writing, of keeping: KeptQueries) async {
    guard !keeping.ended else { return }
    guard !forgotten.withLock({ $0 }) else { return keeping.drop() }
    let named: String?
    do {
      named = try await kept.held()?.personKey
    } catch {
      keeping.drop()
      await report(
        SessionError(
          .sessionKeepFailed,
          "The kept sign-in could not be read before a save: " + String(describing: error),
          kbId: keeping.kbId))
      return
    }
    guard named == writing.person else { return keeping.drop() }
    keeping.write(writing)
  }
}

/// Steps that run one at a time, in the order they are given: each runs to its end, across every
/// suspension in it, before the next begins.
final class SerialSteps: Sendable {
  private let last = Mutex<Task<Void, Never>?>(nil)

  /// Runs `step` once every step given before it has run.
  @discardableResult
  func then<Value: Sendable>(
    _ step: @escaping @Sendable () async throws -> Value
  ) -> Task<Value, any Error> {
    last.withLock { last in
      let previous = last
      let next = Task {
        await previous?.value
        return try await step()
      }
      last = Task { _ = await next.result }
      return next
    }
  }

  /// Waits until every step given so far has run.
  func drained() async { await last.withLock { $0 }?.value }
}

/// The stream places `text` keeps (protocol/specs/src/session/stored.json `lastEventIds`): each
/// pair that is a resource's id and a persisted event's id, and none of a value that is no object.
func storedPlaces(_ text: String?) -> [ResourceId: String] {
  guard case .object(let pairs)? = decodedStorage(JSONValue.self, text) else { return [:] }
  var places: [ResourceId: String] = [:]
  for (scope, place) in pairs {
    guard let resource = ResourceId.parse(scope), case .string(let id) = place,
      isPersistedEventId(id)
    else { continue }
    places[resource] = id
  }
  return places
}

/// One cache's kept values, as the document its key holds (protocol/specs/src/session/stored.json
/// `cacheDocument`): `{"version":1,"entries":[[<key>,<value>,<stamp>],…]}`, each key and value as
/// JSON, and each value with when it was received.
struct KeptDocument: Sendable {
  private var entries: [String: (value: String, stamp: Int64)] = [:]

  /// What `text` keeps of a cache whose keys are `Key`s and values `Value`s: nothing when there is
  /// none or its structure is not a cache document's (not JSON, not an object, of another version,
  /// its entries no list, or an entry not a key, a value and a whole-number stamp of at least 0),
  /// and otherwise each entry whose key is a `Key` and value a `Value`. A number is read by its
  /// value, however it is written.
  init<Key: Codable, Value: Codable>(_ text: String?, keys: Key.Type, values: Value.Type) {
    guard case .object(let document)? = decodedStorage(JSONValue.self, text),
      document["version"] == .number(Double(cacheDocumentVersion)),
      case .array(let listed)? = document["entries"]
    else { return }
    var rows: [(key: JSONValue, value: JSONValue, stamp: Int64)] = []
    for entry in listed {
      guard case .array(let parts) = entry, parts.count == 3, case .number(let at) = parts[2],
        let stamp = Int64(exactly: at), stamp >= 0
      else { return }
      rows.append((parts[0], parts[1], stamp))
    }
    for row in rows {
      guard let key = try? decodedKept(keys, row.key),
        let value = try? decodedKept(values, row.value),
        let keyText = try? keptText(key), let valueText = try? keptText(value)
      else { continue }
      entries[keyText] = (valueText, row.stamp)
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

  /// Keeps `value` as `key`'s, received `now`, and nothing of `key` when it is nil. A value received
  /// again unchanged, its JSON text the text it was kept with, keeps the time it was first received.
  mutating func set<Key: Encodable, Value: Encodable>(_ key: Key, _ value: Value?, at now: Int64) {
    guard let key = try? keptText(key) else { return }
    guard let value else {
      entries[key] = nil
      return
    }
    guard let text = try? keptText(value), entries[key]?.value != text else { return }
    entries[key] = (text, now)
  }

  /// The document as written: the values received longest ago go, and are kept no more, until it
  /// fits within `maxStoredBytesCount`.
  mutating func text() -> String {
    let head = "{\"version\":\(cacheDocumentVersion),\"entries\":["
    let tail = "]}"
    let written = entries.sorted { ($0.value.stamp, $0.key) < ($1.value.stamp, $1.key) }
      .map { (key: $0.key, text: "[\($0.key),\($0.value.value),\($0.value.stamp)]") }
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

private func decodedKept<Kept: Decodable>(_ type: Kept.Type, _ value: JSONValue) throws -> Kept {
  try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
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
