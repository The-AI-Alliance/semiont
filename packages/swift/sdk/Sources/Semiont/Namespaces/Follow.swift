import Foundation

private enum Lifecycle: Sendable {
  case progress(JobReportProgressCommand)
  case failed(JobFailCommand)
  case complete(JobCompleteCommand)
  var jobId: JobId {
    switch self {
    case .progress(let value): value.jobId
    case .failed(let value): value.jobId
    case .complete(.markJobCompleteCommand(let value)): value.jobId
    case .complete(.yieldJobCompleteCommand(let value)): value.jobId
    }
  }
  init?(_ frame: ReceivedFrame) {
    func read<Payload>(_ channel: Channel<Payload>) -> Payload? {
      try? frame.decode(channel)
    }
    switch frame.channel {
    case Channels.jobReportProgress.name:
      guard let value = read(Channels.jobReportProgress) else { return nil }
      self = .progress(value)
    case Channels.jobComplete.name:
      guard let value = read(Channels.jobComplete) else { return nil }
      self = .complete(value)
    case Channels.jobFail.name:
      guard let value = read(Channels.jobFail) else { return nil }
      self = .failed(value)
    default: return nil
    }
  }
}
private enum FollowWake: Sendable {
  case created(Result<JobCreatedResultResponse, any Error>)
  case frame(Lifecycle)
  case closed
  case status(UUID, Result<JobStatusResponse, any Error>)
  case due(UUID)
}
func follow<Completion: FollowedCompletion, Timer: Clock>(
  create: JobCreateCommand, resource: ResourceId, wire: Bus, bus: EventBus,
  lifetime: Lifetime, timing: FollowTiming, stallMs: Int? = nil,
  clock: Timer, completion: Completion.Type
) -> Delegation<Completion> where Timer.Duration == Duration {
  Delegation(
    Running(lifetime: lifetime) { report in
      let source = bus.listen([
        Channels.jobReportProgress.name, Channels.jobComplete.name, Channels.jobFail.name,
      ])
      let (wakes, send) = AsyncStream<FollowWake>.makeStream(bufferingPolicy: .unbounded)
      let arriving = Task {
        do {
          for try await frame in source {
            if let event = Lifecycle(frame) { send.yield(.frame(event)) }
          }
        } catch {}
        send.yield(.closed)
      }
      let creating = Task {
        do {
          send.yield(
            .created(.success(try await wire.request(Operations.jobCreate, create).response)))
        } catch { send.yield(.created(.failure(error))) }
      }
      var timer: Task<Void, Never>?
      var timerID: UUID?
      var asking: (UUID, Task<Void, Never>)?
      defer {
        arriving.cancel()
        creating.cancel()
        timer?.cancel()
        asking?.1.cancel()
        source.dispose()
        send.finish()
      }
      var job: JobCreatedResultResponse?
      var held: [Lifecycle] = []
      var askAt: Timer.Instant?
      var stallAt = stallMs.map { clock.now.advanced(by: .milliseconds($0)) }
      var iterator = wakes.makeAsyncIterator()
      while true {
        try Task.checkCancellation()
        if let deadline = stallAt, clock.now >= deadline {
          if let job { cancelStalled(job.jobId, wire: wire, lifetime: lifetime) }
          throw JobError(
            reason: .jobStalled, description: "The job stalled without an update",
            jobId: job?.jobId, failureClass: nil)
        }
        timer?.cancel()
        timerID = nil
        if let due = [askAt, stallAt].compactMap({ $0 }).min() {
          let id = UUID()
          timerID = id
          timer = Task {
            do {
              try await clock.sleep(until: due, tolerance: nil)
              send.yield(.due(id))
            } catch {}
          }
        }
        guard let wake = await iterator.next() else { throw CancellationError() }
        try Task.checkCancellation()
        var heard: [Lifecycle] = []
        switch wake {
        case .created(let answer):
          job = try answer.get()
          if let job { report(.created(job)) }
          askAt = clock.now.advanced(by: .milliseconds(timing.silenceMs))
          heard = held
          held.removeAll()
        case .frame(let event):
          if job == nil { held.append(event) } else { heard.append(event) }
        case .closed: throw BusRequestError(.busClosed, "The client closed while following a job")
        case .due(let id): if id != timerID { continue }
        case .status(let id, let result):
          guard asking?.0 == id else { continue }
          asking = nil
          let status: JobStatusResponse?
          switch result {
          case .success(let answer): status = answer
          case .failure(is TransportError): status = nil
          case .failure(is BusRequestError): status = nil
          case .failure(let error): throw error
          }
          if let status {
            guard status.jobId == job?.jobId else {
              throw TransportError(.error, "The status is not the followed job's")
            }
            switch status.status {
            case .complete: return .complete(try Completion.learned(status, resource: resource))
            case .failed:
              throw JobError(
                reason: .jobFailed, description: status.error ?? "Job failed", jobId: status.jobId,
                failureClass: status.failureClass)
            case .cancelled:
              throw JobError(
                reason: .jobCancelled, description: "The job was cancelled", jobId: status.jobId,
                failureClass: nil)
            case .pending, .running: break
            }
          }
        }
        for event in heard where event.jobId == job?.jobId {
          asking?.1.cancel()
          asking = nil
          switch event {
          case .progress(let value):
            if let progress = value.progress { report(.progress(progress)) }
            askAt = clock.now.advanced(by: .milliseconds(timing.silenceMs))
          case .failed(let value):
            guard value.willRetry == true else {
              throw JobError(
                reason: .jobFailed, description: value.error, jobId: value.jobId,
                failureClass: value.failureClass)
            }
            report(.failed(value))
            askAt = nil
          case .complete(let value): return .complete(try Completion.matching(value))
          }
          stallAt = stallMs.map { clock.now.advanced(by: .milliseconds($0)) }
        }
        if let deadline = askAt, clock.now >= deadline, let job {
          askAt = clock.now.advanced(by: .milliseconds(timing.statusPollMs))
          if asking == nil {
            let id = UUID()
            asking = (
              id,
              Task {
                do {
                  send.yield(
                    .status(
                      id,
                      .success(
                        try await wire.request(
                          Operations.jobStatusRequested, JobStatusRequest(jobId: job.jobId)
                        ).response)))
                } catch { send.yield(.status(id, .failure(error))) }
              }
            )
          }
        }
      }
    })
}
private func cancelStalled(_ job: JobId, wire: Bus, lifetime: Lifetime) {
  lifetime.start {
    _ = try? await wire.request(Operations.jobCancelRequested, JobCancelRequest(jobId: job))
  }
}
