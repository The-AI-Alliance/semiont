public struct JobNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
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
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: .milliseconds(timeoutMs))
    while true {
      try Task.checkCancellation()
      if clock.now >= deadline { throw BusRequestError(.busTimeout, "Job polling timed out") }
      let answer: JobStatusResponse
      do {
        answer = try await within(until: deadline) { try await status(jobId) }
      } catch is RequestDeadline { throw BusRequestError(.busTimeout, "Job polling timed out") }
      onStatus?(answer)
      switch answer.status {
      case .complete, .failed, .cancelled: return answer
      case .pending, .running: break
      }
      if clock.now >= deadline { throw BusRequestError(.busTimeout, "Job polling timed out") }
      try await clock.sleep(until: min(deadline, clock.now.advanced(by: .milliseconds(intervalMs))))
    }
  }
}
