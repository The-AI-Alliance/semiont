import Foundation
import Synchronization

public let jobClaimChannels = [
  Operations.jobClaim.result.name, Operations.jobClaim.failure.name,
  Channels.jobQueued.name, Channels.jobCancelRequested.name,
].sorted()

public let jobCommitChannels = [
  Operations.markCommit.result.name, Operations.markCommit.failure.name,
  Operations.browseAnnotationRequested.result.name,
  Operations.browseAnnotationRequested.failure.name,
].sorted()

public struct WorkerTiming: Sendable {
  public let claimTimeoutMs: Int
  public let stallMs: Int
  public let stallCheckMs: Int
  public let commitTimeoutMs: Int

  public init(
    claimTimeoutMs: Int? = nil, stallMs: Int? = nil, stallCheckMs: Int? = nil,
    commitTimeoutMs: Int? = nil
  ) {
    self.claimTimeoutMs = claimTimeoutMs ?? Timings.jobClaimTimeoutMs
    self.stallMs = stallMs ?? Timings.heldJobStallMs
    self.stallCheckMs = max(1, stallCheckMs ?? Timings.heldJobStallCheckMs)
    self.commitTimeoutMs = commitTimeoutMs ?? Timings.markCommitTimeoutMs
  }
}

public struct ClaimRefusal: Error, Sendable {
  public let code: BusRequestErrorCode?
  public let detail: String
}

public struct ActiveJob: Encodable, Sendable {
  public let jobId: JobId
  public let jobType: JobType
  public let since: Date
}

public struct WorkerVitals: Encodable, Sendable {
  public internal(set) var lastQueuedEventAt: Date?
  public internal(set) var lastClaimAt: Date?
  public internal(set) var lastFinishedAt: Date?
  public internal(set) var lastActivityAt: Date?
  public internal(set) var activeJob: ActiveJob?
  public internal(set) var jobsCompleted = 0
}

public struct HeldJobStall: Sendable {
  public let jobId: JobId
  public let jobType: JobType
  public let heldSince: Date
  public let lastActivityAt: Date
  public let silentFor: Duration
  public let threshold: Duration
}

public func jobMatchesFilter(_ filter: JSONValue, job: JSONValue) -> Bool {
  guard case .object = filter else { return false }
  return jobStates(filter, actual: job)
}

private func jobStates(_ expected: JSONValue, actual: JSONValue) -> Bool {
  if case .object(let fields) = expected {
    guard case .object(let object) = actual else { return false }
    return fields.allSatisfy { key, value in
      guard let observed = object[key] else { return false }
      return jobStates(value, actual: observed)
    }
  }
  return expected == actual
}

public func willRetryAfter(retryCount: Int, maxRetries: Int, failureClass: FailureClass?) -> Bool {
  guard retryCount < maxRetries else { return false }
  switch failureClass {
  case nil, .transient: return true
  case .deterministic, .withheld: return false
  }
}

/// Claims wake when the stream opens, a matching announcement arrives, or the held job settles.
public actor Claims: AsyncSequence {
  public typealias Element = any HeldJob
  private let transport: any Transport
  private let timing: WorkerTiming
  private let command: JobClaimCommand
  private let filters: [JSONValue]
  private let stream: AsyncStream<any HeldJob>
  private let jobs: AsyncStream<any HeldJob>.Continuation
  private let refusals = Broadcast<ClaimRefusal>()
  public nonisolated let stalled = Watched<HeldJobStall?>(nil)
  private var currentVitals = WorkerVitals()
  public var vitals: WorkerVitals { currentVitals }
  private let iterated = Mutex(false)
  private var readers: [Task<Void, Never>] = []
  private var claimTask: Task<Void, Never>?
  private var held: (any WorkerLease)?
  private var wakeOwed = false
  private var open = false
  private var stopped = false
  private var stopping: Task<Void, Never>?
  private var lastActivity: ContinuousClock.Instant?
  private var stallReported = false

  init(accepts: [JobFilter], transport: any Transport, lifetime: Lifetime, timing: WorkerTiming) {
    self.command = JobClaimCommand(accepts: accepts)
    self.filters = accepts.compactMap { filter in
      (try? wirePayload(filter)).map(JSONValue.object)
    }
    self.transport = transport
    self.timing = timing
    (self.stream, self.jobs) = AsyncStream.makeStream()
    lifetime.onEnd { [weak self] in Task { await self?.abandon() } }
  }

  deinit {
    for reader in readers { reader.cancel() }
    claimTask?.cancel()
    jobs.finish()
    refusals.finish()
    stalled.finish()
  }

  public struct AsyncIterator: AsyncIteratorProtocol {
    fileprivate let owner: Claims?
    fileprivate var reader: AsyncStream<any HeldJob>.Iterator?
    public mutating func next() async -> (any HeldJob)? {
      guard let owner, !Task.isCancelled else { return nil }
      await owner.begin()
      return await reader?.next()
    }
  }

  public nonisolated func makeAsyncIterator() -> AsyncIterator {
    let first = iterated.withLock { taken in
      if taken { return false }
      taken = true
      return true
    }
    return AsyncIterator(
      owner: first ? self : nil, reader: first ? stream.makeAsyncIterator() : nil)
  }

  public nonisolated func refused() -> Events<ClaimRefusal> { refusals.listen() }

  private func begin() async {
    guard readers.isEmpty, !stopped else { return }
    let transport = transport
    let timing = timing
    readers.append(
      Task { [weak self] in
        do {
          let frames = try await transport.frames([
            Channels.jobQueued.name, Channels.jobCancelRequested.name,
          ])
          defer { frames.dispose() }
          await self?.listenToState()
          for try await frame in frames { await self?.hear(frame) }
        } catch {
          if !Task.isCancelled { await self?.refuse(error) }
        }
        if !Task.isCancelled { await self?.abandon() }
      })
    readers.append(
      Task { [weak self] in
        while !Task.isCancelled {
          do { try await sleepMilliseconds(timing.stallCheckMs) } catch { return }
          await self?.checkStall()
        }
      })
  }

  private func listenToState() {
    guard !stopped else { return }
    let transport = transport
    readers.append(
      Task { [weak self] in
        for await state in transport.state {
          if Task.isCancelled { return }
          await self?.connection(state)
        }
      })
  }

  private func connection(_ state: ConnectionState) {
    let previous = open
    open = state == .open
    if open, !previous { pull() }
    if state == .closed { abandon() }
  }

  private func hear(_ frame: ReceivedFrame) async {
    guard !stopped else { return }
    if frame.channel == Channels.jobQueued.name {
      currentVitals.lastQueuedEventAt = Date()
      if filters.contains(where: { jobMatchesFilter($0, job: .object(frame.payload)) }) { pull() }
    } else if case .string(let id) = frame.payload["jobId"], let held, held.jobId.value == id {
      await held.signalCancellation()
    }
  }

  private func pull() {
    guard !stopped, open, held == nil else { return }
    if claimTask != nil {
      wakeOwed = true
      return
    }
    wakeOwed = false
    let transport = transport
    let command = command
    let timing = timing
    claimTask = Task { [weak self] in
      do {
        let frame = try await workerRequest(
          transport, Operations.jobClaim, command, timeoutMs: timing.claimTimeoutMs, parent: [:])
        let answer = try JSONDecoder().decode(
          JobClaimedResult.self, from: JSONEncoder().encode(frame.payload))
        await self?.take(answer.response, trace: frame.trace)
      } catch {
        if !Task.isCancelled { await self?.refuse(error) }
      }
      await self?.claimFinished()
    }
  }

  private func take(_ record: JobRunning, trace: [String: String]?) async {
    let job: any WorkerLease
    switch record.metadata.type {
    case .mark:
      job = HeldWork<MarkJobResult>(
        record: record, trace: trace, transport: transport, owner: self, timing: timing)
    case .yield:
      job = HeldWork<YieldJobResult>(
        record: record, trace: trace, transport: transport, owner: self, timing: timing)
    }
    if stopped {
      try? await job.fail(
        "The worker stopped while it held the job", failureClass: nil, completedUnits: nil,
        unitCursors: nil)
      return
    }
    held = job
    let now = Date()
    currentVitals.lastClaimAt = now
    currentVitals.activeJob = ActiveJob(jobId: job.jobId, jobType: job.jobType, since: now)
    active()
    stallReported = false
    stalled.set(nil)
    wakeOwed = false
    jobs.yield(job)
  }

  private func refuse(_ error: any Error) {
    guard !stopped else { return }
    let code = (error as? BusRequestError)?.reason
    if code != .busNonePending {
      refusals.yield(ClaimRefusal(code: code, detail: String(describing: error)))
    }
  }

  private func claimFinished() {
    claimTask = nil
    if wakeOwed { pull() }
  }

  func active() {
    lastActivity = .now
    currentVitals.lastActivityAt = Date()
  }

  func released(_ job: any WorkerLease, completed: Bool) {
    guard held === job else { return }
    held = nil
    active()
    currentVitals.lastFinishedAt = currentVitals.lastActivityAt
    currentVitals.activeJob = nil
    if completed { currentVitals.jobsCompleted += 1 }
    stalled.set(nil)
    pull()
  }

  private func checkStall() {
    guard !stopped, !stallReported, let job = currentVitals.activeJob, let lastActivity,
      let lastActivityAt = currentVitals.lastActivityAt
    else { return }
    let silence = lastActivity.duration(to: .now)
    let threshold = Duration.milliseconds(timing.stallMs)
    if silence > threshold {
      stallReported = true
      stalled.set(
        HeldJobStall(
          jobId: job.jobId, jobType: job.jobType, heldSince: job.since,
          lastActivityAt: lastActivityAt, silentFor: silence, threshold: threshold))
    }
  }

  public func stop() async {
    if let stopping {
      await stopping.value
      abandon()
      return
    }
    guard !stopped else { return }
    stopped = true
    let job = held
    let pending = claimTask
    let finish = Task {
      if let job {
        try? await job.fail(
          "The worker stopped while it held the job", failureClass: nil, completedUnits: nil,
          unitCursors: nil)
      }
      await pending?.value
    }
    stopping = finish
    await finish.value
    abandon()
  }

  private func abandon() {
    stopped = true
    for reader in readers { reader.cancel() }
    readers.removeAll()
    claimTask?.cancel()
    claimTask = nil
    held = nil
    currentVitals.activeJob = nil
    jobs.finish()
    refusals.finish()
    stalled.finish()
  }
}

func workerRequest<Request: Codable, Result, Failure>(
  _ transport: any Transport, _ operation: Operation<Request, Result, Failure>, _ request: Request,
  timeoutMs: Int, parent: [String: String]? = nil
) async throws -> ReceivedFrame {
  let payload = try wirePayload(request)
  if let http = transport as? HttpTransport {
    return try await http.requestFrame(
      operation: operation.request.name, payload: payload, timeoutMs: timeoutMs, parent: parent)
  }
  let answer = try await transport.request(
    operation: operation.request.name, payload: payload, timeoutMs: timeoutMs)
  return ReceivedFrame(channel: operation.result.name, payload: answer)
}
