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
/// for a person, and its writer (``KeptWriter``) says how and when it writes.
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
    /// It takes no new value: its client is closing.
    var closed = false
    /// It writes nothing more: it has closed, or its sign-in no longer names its person.
    var ended = false
  }

  /// What one write puts in storage: each changed document's text, and the stream's places.
  fileprivate struct Writing: Sendable {
    let person: String
    let documents: [(KeptQuery, String)]
    let places: [ResourceId: String]
  }

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
      guard state.attached != nil, !state.closed else { return }
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

  /// Takes no new value, and writes what is not yet written as its writer writes.
  func close() { writer.close(self) }

  /// Waits until every write begun so far has landed: once it is closed, until its last.
  func closed() async { await writer.closed() }

  private func saved(_ id: UUID) {
    guard state.withLock({ $0.timer.fire(id) }) else { return }
    writer.save(self)
  }

  // What its writers do with it.

  /// What is not yet written, taken to be written; nil when there is none, or it writes no more.
  fileprivate func take() -> Writing? { state.withLock { Self.taken(&$0) } }

  /// Whether it writes nothing more.
  fileprivate var ended: Bool { state.withLock { $0.ended } }

  /// Writes what is not yet written at once, while nothing it holds changes.
  fileprivate func writeNow() {
    state.withLock { state in
      guard let writing = Self.taken(&state), let unwritten = put(writing) else { return }
      Self.restore(&state, unwritten)
    }
  }

  /// Takes no new value, writes what is not yet written at once, and keeps nothing more.
  fileprivate func closeNow() {
    state.withLock { state in
      guard !state.closed else { return }
      state.closed = true
      state.timer.stop()
      // What the close cannot write is kept no more.
      if let writing = Self.taken(&state) { put(writing) }
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
      state.timer.stop()
      return (true, Self.taken(&state))
    }
  }

  /// Writes `writing`, taken before, and keeps what it could not write to be written again.
  fileprivate func write(_ writing: Writing) {
    guard let unwritten = put(writing) else { return }
    state.withLock { Self.restore(&$0, unwritten) }
  }

  /// Its sign-in is not known to name its person: what is not yet written goes, and nothing is
  /// written again.
  fileprivate func drop() {
    state.withLock { state in
      state.timer.stop()
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

  /// What a write did not put in storage is not yet written again; a place heard since stays.
  private static func restore(_ state: inout State, _ unwritten: Writing) {
    state.attached?.changed.formUnion(unwritten.documents.map { $0.0 })
    state.attached?.places.merge(unwritten.places) { heard, _ in heard }
  }

  /// What is not yet written, taken to be written: each changed document's text and, while no
  /// persisted query has a read in flight, the stream's places, so they may lag the documents and
  /// never lead them (B17-Q).
  private static func taken(_ state: inout State) -> Writing? {
    guard !state.ended, var attached = state.attached, !attached.changed.isEmpty else { return nil }
    let now = millisecondsNow()
    var documents: [(KeptQuery, String)] = []
    for query in KeptQuery.allCases where attached.changed.contains(query) {
      guard let text = attached.documents[query]?.text(at: now) else { continue }
      documents.append((query, text))
    }
    attached.changed.removeAll()
    var places: [ResourceId: String] = [:]
    if state.work == 0 { swap(&places, &attached.places) }
    state.attached = attached
    return Writing(person: attached.person, documents: documents, places: places)
  }
}

/// How a client's keeping writes what it holds: ``WritesAsGiven`` for a client an app wires itself
/// with a ``CachePersistence``, ``WritesWhileNamed`` for the client of a session an SDK's builder
/// makes.
protocol KeptWriter: Sendable {
  /// Writes what `keeping` has not yet written, its save being due.
  func save(_ keeping: KeptQueries)
  /// Writes what `keeping` has not yet written as its client closes; it keeps nothing after.
  func close(_ keeping: KeptQueries)
  /// Waits until every write it has begun has landed.
  func closed() async
}

/// The writer of a client an app wires itself: it writes as it is given, at once, so a client has
/// written everything when its closing returns. It asks no sign-in anything: no session of the
/// SDK's holds one for that client.
struct WritesAsGiven: KeptWriter {
  func save(_ keeping: KeptQueries) { keeping.writeNow() }
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

  func save(_ keeping: KeptQueries) {
    steps.then { [weak keeping, self] in
      guard let keeping, let writing = keeping.take() else { return }
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
