import Synchronization

/// A delegation starts when the preceding request has been answered.
final class DelegationTurns: Sendable {
  struct Turn: Sendable {
    fileprivate let previous: SharedWait<Void>?
    fileprivate let answered: SharedWait<Void>

    func wait() async throws {
      if let previous {
        try await withCheckedThrowingContinuation { previous.install($0) }
      }
      try Task.checkCancellation()
    }

    func releaseNext() { answered.resolve(.success(())) }
  }

  private let tail = Mutex<SharedWait<Void>?>(nil)

  func next() -> Turn {
    tail.withLock { tail in
      let answered = SharedWait<Void>()
      let turn = Turn(previous: tail, answered: answered)
      tail = answered
      return turn
    }
  }
}
