import Synchronization

/// A keyed collection of shared, read-through queries.
public final class Cache<Key: Hashable & Sendable, Value: Sendable>: StateUnit {
  private let entries = Mutex<[Key: Cached<Value>]>([:])
  private let ownsLifetime: Bool
  private let holdFor: (@Sendable (Key) async -> ResourceHold)?
  private let lifetime: Lifetime
  private let kept: (@Sendable (Key) -> KeptValue<Value>?)?
  private let owed: Unsettled?
  private let invalidationWindowMs: Int
  private let clock: any Clock<Duration>
  private let persistenceWork: (@Sendable () -> Bool)?
  private let fetch: @Sendable (Key) async throws -> Value

  init(
    lifetime: Lifetime, ownsLifetime: Bool = false,
    hold: (@Sendable (Key) async -> ResourceHold)? = nil,
    kept: (@Sendable (Key) -> KeptValue<Value>?)? = nil, owed: Unsettled?,
    invalidationWindowMs: Int, clock: any Clock<Duration>,
    persistencePending: (@Sendable () -> Bool)? = nil,
    fetch: @escaping @Sendable (Key) async throws -> Value
  ) {
    self.ownsLifetime = ownsLifetime
    self.holdFor = hold
    self.lifetime = lifetime
    self.kept = kept
    self.owed = owed
    self.invalidationWindowMs = invalidationWindowMs
    self.clock = clock
    self.persistenceWork = persistencePending
    self.fetch = fetch
    lifetime.onEnd { [weak self] in
      self?.entries.withLock { $0.removeAll() }
    }
  }

  public convenience init(
    clock: any Clock<Duration> = ContinuousClock(),
    fetch: @escaping @Sendable (Key) async throws -> Value
  ) {
    self.init(
      lifetime: Lifetime(), ownsLifetime: true, owed: nil,
      invalidationWindowMs: Timings.invalidationWindowMs, clock: clock, fetch: fetch)
  }

  /// A cache whose values `persister` keeps: it starts with every value kept, each asked for again
  /// when first observed (B17, B18), and it closes `persister` when it is disposed.
  public convenience init(
    persister: StoragePersister<Key, Value>, clock: any Clock<Duration> = ContinuousClock(),
    fetch: @escaping @Sendable (Key) async throws -> Value
  ) where Key: Codable, Value: Codable {
    let life = Lifetime()
    life.onEnd { persister.close() }
    self.init(
      lifetime: life, ownsLifetime: true, kept: { KeptValue(book: persister, key: $0) },
      owed: persister.underway, invalidationWindowMs: Timings.invalidationWindowMs, clock: clock,
      persistencePending: { persister.pending }, fetch: fetch)
    for key in persister.keys { _ = observe(key) }
  }

  public func observe(_ key: Key) -> Cached<Value> {
    let fetch = fetch
    let clock = clock
    let hold: (@Sendable () async -> ResourceHold)?
    if let holdFor {
      hold = { await holdFor(key) }
    } else {
      hold = nil
    }
    return entries.withLock { entries in
      if let query = entries[key] { return query }
      let query = Cached(
        lifetime: lifetime, hold: hold, kept: kept?(key), owed: owed,
        invalidationWindowMs: invalidationWindowMs,
        clock: clock
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

  /// Writes the part of `key`'s value that is known: `change` takes the value to the patched one
  /// (CACHE-SEMANTICS B13b). A key that holds neither a value nor a fetch is left as it is.
  public func patch(_ key: Key, _ change: @escaping @Sendable (Value) -> Value) async {
    await existing(key)?.patch(change)
  }

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
