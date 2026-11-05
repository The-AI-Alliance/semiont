/// Holds generation progress and the outcome until it is dismissed or another run begins.
public final class YieldStateUnit: StateUnit {
  public let isGenerating = Watched(false)
  public let progress = Watched<JobProgress?>(nil)
  public let outcome = Watched<YieldJobDone?>(nil)
  public let failure = Watched<(any Error)?>(nil)
  public let jobId = Watched<JobId?>(nil)

  private let yield: YieldNamespace
  private let locale: String
  private let life = Lifetime()
  private let turns = DelegationTurns()

  public init(client: SemiontClient, locale: String) {
    yield = client.yield
    self.locale = locale
  }

  public func generate(_ params: GenerationJobParams, stallDeadlineMs: Int? = nil) {
    var input = params
    if input.language?.isEmpty != false { input.language = locale }
    let request = input
    var turn: DelegationTurns.Turn?
    life.whileOpen {
      clearDisplay()
      jobId.set(nil)
      turn = turns.next()
    }
    guard let turn else { return }
    life.start { [weak self, yield] in
      defer { turn.releaseNext() }
      var created: JobId?
      do {
        try await turn.wait()
        let run = try yield.delegate(params: request, stallDeadlineMs: stallDeadlineMs)
        for try await event in run {
          turn.releaseNext()
          if case .created(let answer) = event { created = answer.jobId }
          self?.receive(event)
        }
        self?.finish(created, failure: nil)
      } catch {
        self?.finish(created, failure: error)
      }
    }
  }

  private func receive(_ event: JobEvent<YieldJobCompleteCommand>) {
    life.whileOpen {
      switch event {
      case .created(let answer): jobId.set(answer.jobId)
      case .progress(let value):
        progress.set(value)
        isGenerating.set(true)
      case .complete(let answer):
        if case .yieldJobDone(let result) = answer.result { outcome.set(result) }
      case .failed: break
      }
    }
  }

  private func finish(_ created: JobId?, failure error: (any Error)?) {
    life.whileOpen {
      if let error {
        failure.set(error)
        if (error as? JobError)?.reason != .jobCancelled { progress.set(nil) }
      }
      isGenerating.set(false)
      if let created, jobId.value == created { jobId.set(nil) }
    }
  }

  public func dismissProgress() { life.whileOpen { clearDisplay() } }

  private func clearDisplay() {
    progress.set(nil)
    outcome.set(nil)
    failure.set(nil)
  }

  public func dispose() {
    life.end()
    isGenerating.finish()
    progress.finish()
    outcome.finish()
    failure.finish()
    jobId.finish()
  }

  deinit { dispose() }
}
