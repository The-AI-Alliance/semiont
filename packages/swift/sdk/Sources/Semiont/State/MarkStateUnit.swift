import Foundation
import Synchronization

public struct PendingAnnotation: Encodable, Sendable {
  public let selector: AnnotationSelector
  public let motivation: Motivation
}

/// Holds a composition and its delegated job for one resource.
public final class MarkStateUnit: StateUnit {
  public let pendingAnnotation = Watched<PendingAnnotation?>(nil)
  public let delegatingMotivation = Watched<Motivation?>(nil)
  public let progress = Watched<JobProgress?>(nil)
  public let progressMotivation = Watched<Motivation?>(nil)
  public let failure = Watched<(any Error)?>(nil)
  public let jobId = Watched<JobId?>(nil)

  private let mark: MarkNamespace
  private let bus: EventBus
  private let resourceId: ResourceId
  private let silence: Duration
  private let clock: any Clock<Duration>
  private let life = Lifetime()
  private let turns = DelegationTurns()

  public convenience init(client: SemiontClient, resourceId: ResourceId) {
    self.init(client: client, resourceId: resourceId, clock: ContinuousClock())
  }

  package init(
    client: SemiontClient, resourceId: ResourceId, clock: any Clock<Duration>
  ) {
    mark = client.mark
    bus = client.bus
    self.resourceId = resourceId
    self.silence = .milliseconds(Timings.delegateSilenceMs)
    self.clock = clock
    let frames = bus.listen([Channels.markRequested.name, Channels.markSubmit.name])
    life.onEnd { frames.dispose() }
    life.start { [weak self] in
      do {
        for try await frame in frames { self?.hear(frame) }
      } catch {}
    }
  }

  public func cancelPending() { life.whileOpen { pendingAnnotation.set(nil) } }

  public func dismissProgress() {
    life.whileOpen {
      progress.set(nil)
      progressMotivation.set(nil)
      failure.set(nil)
    }
  }

  private func hear(_ frame: ReceivedFrame) {
    switch frame.channel {
    case Channels.markRequested.name:
      guard let request = try? frame.decode(Channels.markRequested), request.source == resourceId
      else { return }
      life.whileOpen {
        pendingAnnotation.set(
          PendingAnnotation(selector: request.selector, motivation: request.motivation))
      }
    case Channels.markSubmit.name:
      guard let submission = try? frame.decode(Channels.markSubmit), submission.source == resourceId
      else { return }
      let request = CreateAnnotationRequest(
        body: submission.body, motivation: submission.motivation,
        target: AnnotationTarget(selector: submission.selector, source: resourceId))
      life.start { [weak self, mark] in
        do {
          _ = try await mark.annotation(request)
          self?.cancelPending()
        } catch {
          self?.creationFailed(error)
        }
      }
    default: break
    }
  }

  private func creationFailed(_ error: any Error) {
    life.whileOpen {
      try? bus.emit(
        Channels.markCreateError,
        ResourceErrorEvent(message: String(describing: error), resourceId: resourceId))
    }
  }

  public func requestDelegate(_ params: MarkJobParams) {
    let motivation = params.motivation
    var turn: DelegationTurns.Turn?
    life.whileOpen {
      delegatingMotivation.set(motivation)
      progress.set(nil)
      progressMotivation.set(motivation)
      failure.set(nil)
      jobId.set(nil)
      turn = turns.next()
    }
    guard let turn else { return }
    life.start { [weak self, mark, resourceId, clock, silence] in
      let timer = DelegationSilence(clock: clock, delay: silence) { [weak self] in
        self?.goneQuiet(motivation)
      }
      defer { turn.releaseNext() }
      var created: JobId?
      do {
        try await turn.wait()
        timer.reset()
        for try await event in mark.delegate(resourceId: resourceId, params: params) {
          timer.reset()
          turn.releaseNext()
          if case .created(let answer) = event { created = answer.jobId }
          self?.receive(event)
        }
        timer.stop()
        self?.finish(created, failure: nil)
      } catch {
        timer.stop()
        self?.finish(created, failure: error)
      }
    }
  }

  private func receive(_ event: JobEvent<MarkJobCompleteCommand>) {
    life.whileOpen {
      switch event {
      case .created(let answer): jobId.set(answer.jobId)
      case .progress(let value): progress.set(value)
      case .complete, .failed: break
      }
    }
  }

  private func goneQuiet(_ motivation: Motivation) {
    life.whileOpen {
      if progress.value == nil { progress.set(JobProgress(percentage: 0)) }
      try? bus.emit(
        Channels.markDelegateTimeout,
        MarkDelegateTimeoutEvent(motivation: motivation, resourceId: resourceId))
    }
  }

  private func finish(_ created: JobId?, failure error: (any Error)?) {
    life.whileOpen {
      if let error {
        failure.set(error)
        if (error as? JobError)?.reason != .jobCancelled {
          progress.set(nil)
          progressMotivation.set(nil)
        }
      }
      delegatingMotivation.set(nil)
      if let created, jobId.value == created { jobId.set(nil) }
    }
  }

  public func dispose() {
    life.end()
    pendingAnnotation.finish()
    delegatingMotivation.finish()
    progress.finish()
    progressMotivation.finish()
    failure.finish()
    jobId.finish()
  }

  deinit { dispose() }
}

extension MarkJobParams {
  fileprivate var motivation: Motivation {
    switch self {
    case .highlightingJobParams: .highlighting
    case .commentingJobParams: .commenting
    case .assessingJobParams: .assessing
    case .linkingJobParams: .linking
    case .taggingJobParams: .tagging
    }
  }
}

private final class DelegationSilence: Sendable {
  private struct Timer: Sendable {
    var generation = 0
    var task: Task<Void, Never>?
  }

  private let timer = Mutex(Timer())
  private let clock: any Clock<Duration>
  private let delay: Duration
  private let elapsed: @Sendable () -> Void

  init(clock: any Clock<Duration>, delay: Duration, elapsed: @escaping @Sendable () -> Void) {
    self.clock = clock
    self.delay = delay
    self.elapsed = elapsed
  }

  func reset() {
    timer.withLock { timer in
      timer.task?.cancel()
      timer.generation += 1
      let generation = timer.generation
      timer.task = Task { [weak self, clock, delay] in
        do {
          try await clock.sleep(for: delay)
          self?.due(generation)
        } catch {}
      }
    }
  }

  private func due(_ generation: Int) {
    timer.withLock { timer in
      if timer.generation == generation { elapsed() }
    }
  }

  func stop() {
    timer.withLock { timer in
      timer.generation += 1
      timer.task?.cancel()
      timer.task = nil
    }
  }

  deinit { stop() }
}
