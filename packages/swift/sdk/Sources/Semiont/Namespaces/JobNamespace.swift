public struct JobNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  let transport: any Transport
  let lifetime: Lifetime
  let clock: any Clock<Duration>

  public func claim(_ accepts: [JobFilter], timing: WorkerTiming = WorkerTiming()) -> Claims {
    Claims(
      accepts: accepts, transport: transport, lifetime: lifetime, timing: timing, clock: clock)
  }
  public func queued() -> Typed<JobQueuedEvent> { bus.frames(Channels.jobQueued) }
  public func progress() -> Typed<JobReportProgressCommand> {
    bus.frames(Channels.jobReportProgress)
  }
  public func complete() -> Typed<JobCompleteCommand> { bus.frames(Channels.jobComplete) }
  public func fail() -> Typed<JobFailCommand> { bus.frames(Channels.jobFail) }
  public func status(_ jobId: JobId) async throws -> JobStatusResponse {
    try await wire.request(Operations.jobStatusRequested, JobStatusRequest(jobId: jobId)).response
  }
  public func cancel(_ jobId: JobId) async throws -> Bool {
    try await wire.request(Operations.jobCancelRequested, JobCancelRequest(jobId: jobId)).response
      .cancelled
  }
  public func pollUntilComplete(
    _ jobId: JobId, intervalMs: Int = 1000, timeoutMs: Int = 60000,
    onStatus: (@Sendable (JobStatusResponse) -> Void)? = nil
  ) async throws -> JobStatusResponse {
    let timeout = Duration.milliseconds(timeoutMs)
    let elapsed = stopwatch(clock)
    while true {
      try Task.checkCancellation()
      if elapsed() >= timeout { throw BusRequestError(.busTimeout, "Job polling timed out") }
      let answer: JobStatusResponse
      do {
        answer = try await within(timeout - elapsed(), on: clock) { try await status(jobId) }
      } catch is RequestDeadline { throw BusRequestError(.busTimeout, "Job polling timed out") }
      onStatus?(answer)
      switch answer.status {
      case .complete, .failed, .cancelled: return answer
      case .pending, .running: break
      }
      let left = timeout - elapsed()
      if left <= .zero { throw BusRequestError(.busTimeout, "Job polling timed out") }
      try await clock.sleep(for: min(left, .milliseconds(intervalMs)))
    }
  }
}
