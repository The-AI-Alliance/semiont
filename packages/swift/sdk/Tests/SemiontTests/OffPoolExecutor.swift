import Dispatch

@testable import Semiont

/// Runs each job on a thread of Dispatch's, for a case whose storage holds a write open on the
/// thread that writes. Swift's shared pool has one thread per core and adds none while one is held,
/// so a held write there starves its own case's work, and the cases running beside it, until the
/// hold times out. Dispatch adds a thread while one of its own is held.
final class OffPoolExecutor: TaskExecutor {
  private let queue = DispatchQueue(label: "held writes", attributes: .concurrent)

  func enqueue(_ job: consuming ExecutorJob) {
    let job = UnownedJob(job)
    queue.async { job.runSynchronously(on: self.asUnownedTaskExecutor()) }
  }

  /// Runs `body` with every task the SDK spawns from it on a thread of Dispatch's.
  static func run<Value>(_ body: () async throws -> Value) async rethrows -> Value {
    try await Spawning.$executor.withValue(OffPoolExecutor()) { try await body() }
  }
}
