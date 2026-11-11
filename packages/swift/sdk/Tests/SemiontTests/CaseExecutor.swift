import Dispatch
import Foundation
import Synchronization
import Testing

@testable import Semiont

/// One thread that runs a case's work in the order it was made ready. A job is either queued here
/// or is the one this thread runs, so an empty queue, seen by the job that runs, means nothing the
/// case made ready is left to run.
final class CaseExecutor: TaskExecutor {
  private struct Line {
    var jobs: [UnownedJob] = []
    var stopping = false
    var stopped = false
    var late = 0
  }

  private let line = Mutex(Line())
  private let ready = DispatchSemaphore(value: 0)
  private let thread = Atomic<UInt>(0)
  /// How many jobs were made ready once its thread had ended: work its case left behind.
  var late: Int { line.withLock { $0.late } }

  init() {
    let started = DispatchSemaphore(value: 0)
    let worker = Thread { [self] in
      thread.store(currentThreadID(), ordering: .releasing)
      started.signal()
      while let job = next() { job.runSynchronously(on: asUnownedTaskExecutor()) }
    }
    worker.name = "state case"
    worker.start()
    started.wait()
  }

  /// The next job, once one is ready; none once it is stopping and nothing is left.
  private func next() -> UnownedJob? {
    while true {
      ready.wait()
      let taken: (job: UnownedJob?, ended: Bool) = line.withLock { line in
        if !line.jobs.isEmpty { return (line.jobs.removeFirst(), false) }
        line.stopped = line.stopping
        return (nil, line.stopped)
      }
      if let job = taken.job { return job }
      if taken.ended { return nil }
    }
  }

  func enqueue(_ job: consuming ExecutorJob) {
    let job = UnownedJob(job)
    let queued = line.withLock { line in
      if line.stopped { line.late += 1 } else { line.jobs.append(job) }
      return !line.stopped
    }
    if queued {
      ready.signal()
    } else {
      globalConcurrentExecutor.enqueue(ExecutorJob(job))
    }
  }

  /// Runs `body` as a case: its task, and every task the SDK spawns from it, prefers this executor.
  func run<Value>(_ body: () async throws -> Value) async rethrows -> Value {
    try await withTaskExecutorPreference(self) {
      try await Spawning.$executor.withValue(self) { try await body() }
    }
  }

  /// Lets what is ready run, and what that makes ready, until nothing more is. Time does not move.
  func settle() async {
    if thread.load(ordering: .acquiring) != currentThreadID() {
      Issue.record("A settle ran off its case's thread, where it sees nothing of the case")
    }
    repeat { await Task.yield() } while !line.withLock({ $0.jobs.isEmpty })
  }

  /// Ends its thread once nothing is left to run. A job made ready after that is late: it is
  /// counted, and runs on the global executor, so that nothing waits on it forever.
  func stop() {
    line.withLock { $0.stopping = true }
    ready.signal()
  }
}

private func currentThreadID() -> UInt {
  #if canImport(Darwin)
    UInt(bitPattern: pthread_self())
  #else
    UInt(pthread_self())
  #endif
}
