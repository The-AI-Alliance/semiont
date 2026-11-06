import Synchronization

struct RequestDeadline: Error {}

/// `operation`, ended by RequestDeadline once `duration` has passed on `clock`.
func within<Value: Sendable>(
  _ duration: Duration, on clock: any Clock<Duration>,
  operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
  try await withThrowingTaskGroup(of: Value.self) { group in
    group.addTask { try await operation() }
    group.addTask {
      try await clock.sleep(for: duration)
      throw RequestDeadline()
    }
    defer { group.cancelAll() }
    guard let value = try await group.next() else { throw CancellationError() }
    return value
  }
}

func sleepMilliseconds(_ milliseconds: Int, on clock: any Clock<Duration>) async throws {
  try Task.checkCancellation()
  if milliseconds > 0 { try await clock.sleep(for: .milliseconds(milliseconds)) }
}

/// How much time has passed on `clock` since the stopwatch was made.
func stopwatch(_ clock: any Clock<Duration>) -> @Sendable () -> Duration {
  func started(_ clock: some Clock<Duration>) -> @Sendable () -> Duration {
    let start = clock.now
    return { start.duration(to: clock.now) }
  }
  return started(clock)
}

/// A caller's random source, shared by everything handed it, so that their draws are one sequence.
package final class RandomSource: RandomNumberGenerator, Sendable {
  private let generator: Mutex<any RandomNumberGenerator & Sendable>
  package init(_ generator: any RandomNumberGenerator & Sendable) {
    self.generator = Mutex(generator)
  }
  package func next() -> UInt64 { generator.withLock { $0.next() } }
}

func equalJitter(_ cap: Int, from random: RandomSource) -> Int {
  var draws = random
  return Int.random(in: (max(0, cap) / 2)...max(0, cap), using: &draws)
}
