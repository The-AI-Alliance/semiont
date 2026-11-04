import Foundation
import Synchronization

/// Turns pointer rests into hover signals after a delay.
public final class HoverDwell: StateUnit {
  private struct Dwell: Sendable {
    var pending: Task<Void, Never>?
    var generation = 0
    var hovered: AnnotationId?
    var disposed = false
  }

  private let dwell = Mutex(Dwell())
  private let clock: any Clock<Duration>
  private let delay: Duration
  private let say: @Sendable (AnnotationId?) -> Void

  /// The callback receives each change in order and must not call the dwell back.
  public convenience init(
    delay: Duration? = nil, say: @escaping @Sendable (AnnotationId?) -> Void
  ) {
    self.init(delay: delay, clock: ContinuousClock(), say: say)
  }

  package init(
    delay: Duration? = nil, clock: any Clock<Duration>,
    say: @escaping @Sendable (AnnotationId?) -> Void
  ) {
    self.delay = delay ?? .milliseconds(Timings.hoverDelayMs)
    self.clock = clock
    self.say = say
  }

  public func enter(_ annotationId: AnnotationId) {
    dwell.withLock { state in
      guard !state.disposed else { return }
      state.pending?.cancel()
      state.pending = nil
      state.generation += 1
      guard state.hovered != annotationId else { return }
      let generation = state.generation
      state.pending = Task { [weak self, clock, delay] in
        do {
          try await clock.sleep(for: delay)
          self?.rested(annotationId, generation: generation)
        } catch {}
      }
    }
  }

  private func rested(_ annotationId: AnnotationId, generation: Int) {
    dwell.withLock { state in
      guard !state.disposed, state.generation == generation else { return }
      state.pending = nil
      state.hovered = annotationId
      say(annotationId)
    }
  }

  public func leave() {
    dwell.withLock { state in
      guard !state.disposed else { return }
      state.pending?.cancel()
      state.pending = nil
      state.generation += 1
      guard state.hovered != nil else { return }
      state.hovered = nil
      say(nil)
    }
  }

  public func dispose() {
    dwell.withLock { state in
      state.disposed = true
      state.pending?.cancel()
      state.pending = nil
    }
  }

  deinit { dispose() }
}
