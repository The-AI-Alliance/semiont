import Synchronization

/// A keyed collection of shared, read-through queries.
public final class Cache<Key: Hashable & Sendable, Value: Sendable>: StateUnit {
  private let entries = Mutex<[Key: Cached<Value>]>([:])
  private let ownsLifetime: Bool
  private let holdFor: (@Sendable (Key) async -> ResourceHold)?
  private let lifetime: Lifetime
  private let kept: (@Sendable (Key) -> KeptValue<Value>?)?
  private let invalidationWindowMs: Int
  private let persistenceWork: (@Sendable () -> Bool)?
  private let fetch: @Sendable (Key) async throws -> Value

  init(
    lifetime: Lifetime, ownsLifetime: Bool = false,
    hold: (@Sendable (Key) async -> ResourceHold)? = nil,
    kept: (@Sendable (Key) -> KeptValue<Value>?)? = nil, invalidationWindowMs: Int,
    persistencePending: (@Sendable () -> Bool)? = nil,
    fetch: @escaping @Sendable (Key) async throws -> Value
  ) {
    self.ownsLifetime = ownsLifetime
    self.holdFor = hold
    self.lifetime = lifetime
    self.kept = kept
    self.invalidationWindowMs = invalidationWindowMs
    self.persistenceWork = persistencePending
    self.fetch = fetch
    lifetime.onEnd { [weak self] in
      self?.entries.withLock { $0.removeAll() }
    }
  }

  public convenience init(fetch: @escaping @Sendable (Key) async throws -> Value) {
    self.init(
      lifetime: Lifetime(), ownsLifetime: true, invalidationWindowMs: Timings.invalidationWindowMs,
      fetch: fetch)
  }

  public convenience init(
    persistence: CachePersistence, fetch: @escaping @Sendable (Key) async throws -> Value
  ) where Key: Codable, Value: Codable {
    let life = Lifetime()
    let book = StoragePersister<Key>(persistence)
    life.onEnd { book.close() }
    self.init(
      lifetime: life, ownsLifetime: true, kept: { KeptValue(book: book, key: $0) },
      invalidationWindowMs: Timings.invalidationWindowMs,
      persistencePending: { book.pending }, fetch: fetch)
    for key in book.keys { _ = observe(key) }
  }

  public func observe(_ key: Key) -> Cached<Value> {
    let fetch = fetch
    let hold: (@Sendable () async -> ResourceHold)?
    if let holdFor {
      hold = { await holdFor(key) }
    } else {
      hold = nil
    }
    return entries.withLock { entries in
      if let query = entries[key] { return query }
      let query = Cached(
        lifetime: lifetime, hold: hold, kept: kept?(key), invalidationWindowMs: invalidationWindowMs
      ) {
        try await fetch(key)
      }
      if !lifetime.ended { entries[key] = query }
      return query
    }
  }

  public func fetch(_ key: Key) async throws -> Value { try await observe(key).fresh() }

  public func get(_ key: Key) async -> Value? { await existing(key)?.snapshot() }

  public func known(_ key: Key) async -> Bool { await existing(key)?.isKnown() == true }

  public func keys() async -> [Key] {
    let snapshot = entries.withLock { $0 }
    var known: [Key] = []
    for (key, query) in snapshot where await query.isKnown() { known.append(key) }
    return known
  }

  public func invalidate(_ key: Key) async { await observe(key).invalidate() }

  public func invalidateAll() async {
    for key in await keys() { await invalidate(key) }
  }

  public func remove(_ key: Key, gone: any Error) async {
    await observe(key).replace(.failed(gone))
  }

  public func set(_ key: Key, value: Value) async { await observe(key).replace(.ready(value)) }

  public func persistencePending() -> Bool { persistenceWork?() == true }

  public func dispose() { lifetime.end() }

  deinit { if ownsLifetime { dispose() } }

  func existing(_ key: Key) -> Cached<Value>? { entries.withLock { $0[key] } }

  func matching(_ matches: (Key) -> Bool) -> [Cached<Value>] {
    entries.withLock { entries in entries.compactMap { matches($0.key) ? $0.value : nil } }
  }

  func refresh(_ key: Key?, coalescing: Bool) async {
    if let key {
      await existing(key)?.refreshIfKnown(coalescing: coalescing)
      return
    }
    for query in matching({ _ in true }) { await query.refreshIfKnown(coalescing: coalescing) }
  }
}
