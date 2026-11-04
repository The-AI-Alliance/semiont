import Foundation
import Semiont
import Synchronization

/// A manually advanced clock for timeout, debounce and retry tests.
public final class TestClock: Clock {
  public init() {}
  public struct Instant: InstantProtocol {
    let offset: Duration
    public func advanced(by duration: Duration) -> Instant { Instant(offset: offset + duration) }
    public func duration(to other: Instant) -> Duration { other.offset - offset }
    public static func < (left: Instant, right: Instant) -> Bool { left.offset < right.offset }
  }

  private struct Reading: Sendable {
    var now = Instant(offset: .zero)
    var sleeping: [UUID: (Instant, SharedWait<Void>)] = [:]
  }

  private let reading = Mutex(Reading())
  public var now: Instant { reading.withLock { $0.now } }
  public var minimumResolution: Duration { .nanoseconds(1) }

  public func sleep(until deadline: Instant, tolerance: Duration?) async throws {
    let id = UUID()
    let waiter = SharedWait<Void>()
    defer { _ = reading.withLock { $0.sleeping.removeValue(forKey: id) } }
    try await withTaskCancellationHandler {
      try Task.checkCancellation()
      let due = reading.withLock { reading in
        guard deadline > reading.now else { return true }
        reading.sleeping[id] = (deadline, waiter)
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
      reading.now = reading.now.advanced(by: duration)
      let due = reading.sleeping.filter { $0.value.0 <= reading.now }
      for id in due.keys { reading.sleeping.removeValue(forKey: id) }
      return due.values.map(\.1)
    }
    for waiter in due { waiter.resolve(.success(())) }
  }
}
