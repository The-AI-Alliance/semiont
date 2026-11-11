import Foundation
import Semiont
import Synchronization

/// A manually advanced clock for timeout, debounce and retry tests. Sleepers due at one instant wake
/// in the order they slept.
public final class TestClock: Clock {
  public init() {}
  public struct Instant: InstantProtocol {
    let offset: Duration
    public func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    public func duration(to other: Instant) -> Duration { other.offset - offset }
    public static func < (left: Instant, right: Instant) -> Bool { left.offset < right.offset }
  }

  private struct Sleeper: Sendable {
    let deadline: Instant
    let order: Int
    let waiter: SharedWait<Void>
  }

  private struct Reading: Sendable {
    var now = Instant(offset: .zero)
    var sleeping: [UUID: Sleeper] = [:]
    var slept = 0
  }

  private let reading = Mutex(Reading())
  private let strayCount = Atomic(0)
  public var now: Instant { reading.withLock { $0.now } }
  public var minimumResolution: Duration { .nanoseconds(1) }
  /// The instants its sleepers wait for, earliest first.
  var wakes: [Instant] { reading.withLock { $0.sleeping.values.map(\.deadline).sorted() } }
  /// How many sleeps a task that does not prefer the bound executor began: work a settle on that
  /// executor cannot see.
  package var strays: Int { strayCount.load(ordering: .relaxed) }

  public func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    if !Spawning.onBoundExecutor { strayCount.add(1, ordering: .relaxed) }
    let id = UUID()
    let waiter = SharedWait<Void>()
    defer { _ = reading.withLock { $0.sleeping.removeValue(forKey: id) } }
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      let due = reading.withLock { reading in
        guard deadline > reading.now else { return true }
        reading.sleeping[id] = Sleeper(deadline: deadline, order: reading.slept, waiter: waiter)
        reading.slept += 1
        return false
      }
      if !due {
        try await withCheckedThrowingContinuation { waiter.install($0) }
      }
    } onCancel: {
      waiter.resolve(.failure(CancellationError()))
    }
  }

  public func advance(by duration: Duration) {
    let due = reading.withLock { reading in
      let now = reading.now.advanced(by: duration)
      reading.now = now
      return taken(from: &reading) { $0.deadline <= now }
    }
    for waiter in due { waiter.resolve(.success(())) }
  }

  /// Moves to the earliest instant a sleeper waits for and wakes the sleepers due then, when that
  /// instant is no later than `target`, and says so; with none due so soon, moves to `target`.
  package func wakeNext(through target: Instant) -> Bool {
    let due = reading.withLock { reading -> [SharedWait<Void>] in
      guard let next = reading.sleeping.values.map(\.deadline).min(), next <= target else {
        reading.now = max(reading.now, target)
        return []
      }
      reading.now = max(reading.now, next)
      return taken(from: &reading) { $0.deadline == next }
    }
    for waiter in due { waiter.resolve(.success(())) }
    return !due.isEmpty
  }

  /// The sleepers `isDue` picks, taken from `reading`, earliest first and, at one instant, in the
  /// order they slept.
  private func taken(from reading: inout Reading, _ isDue: (Sleeper) -> Bool) -> [SharedWait<Void>]
  {
    let due = reading.sleeping.filter { isDue($0.value) }
    for id in due.keys { reading.sleeping.removeValue(forKey: id) }
    return due.values.sorted { ($0.deadline, $0.order) < ($1.deadline, $1.order) }.map(\.waiter)
  }
}
