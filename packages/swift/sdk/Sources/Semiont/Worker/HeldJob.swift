import Foundation
import OpenTelemetryApi
import Synchronization

public protocol HeldJob: Sendable {
  var jobId: JobId { get }
  var jobType: JobType { get }
  var resourceId: ResourceId { get }
  var params: JobParams { get }
  var completedUnits: [String] { get }
  var unitCursors: [String: UnitCursor] { get }
  var retryCount: Int { get }
  var maxRetries: Int { get }
  var attempt: Int { get }
  var annotationId: AnnotationId? { get }
  var trace: [String: String]? { get }
  var cancelled: Watched<Bool> { get }
  var settled: Bool { get async }
  func start() async throws
  func progress(_ progress: JobProgress) async throws
  func checkpoint(completedUnits: [String], unitCursors: [String: UnitCursor]?) async throws
  func commit(resourceId: ResourceId, annotations: [Annotation]) async throws
  func fail(
    _ message: String, failureClass: FailureClass?, completedUnits: [String]?,
    unitCursors: [String: UnitCursor]?
  ) async throws
  func cancel(completedUnits: [String]?, unitCursors: [String: UnitCursor]?) async throws
}

public protocol HeldMarkJob: HeldJob {
  func complete(_ result: MarkJobResult) async throws
}

public protocol HeldYieldJob: HeldJob {
  func complete(_ result: YieldJobResult) async throws
}

protocol WorkerLease: HeldJob, AnyObject {
  func signalCancellation() async
}

actor HeldWork<Result: Sendable>: WorkerLease {
  nonisolated let jobId: JobId
  nonisolated let jobType: JobType
  nonisolated let resourceId: ResourceId
  nonisolated let params: JobParams
  nonisolated let completedUnits: [String]
  nonisolated let unitCursors: [String: UnitCursor]
  nonisolated let retryCount: Int
  nonisolated let maxRetries: Int
  nonisolated var attempt: Int { retryCount + 1 }
  nonisolated let annotationId: AnnotationId?
  nonisolated let trace: [String: String]?
  nonisolated let cancelled = Watched(false)
  private(set) var settled = false

  private let transport: any Transport
  private weak var owner: Claims?
  private let timing: WorkerTiming
  private let span: Mutex<(any Span)?>
  private let workingTrace: [String: String]
  private var begun = false
  private var operating = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var durability: DurabilityEvidence?

  init(
    record: JobRunning, trace: [String: String]?, transport: any Transport, owner: Claims,
    timing: WorkerTiming
  ) {
    let metadata = record.metadata
    jobId = metadata.id
    jobType = metadata.type
    resourceId = record.params.resourceId
    params = record.params
    completedUnits = metadata.completedUnits ?? []
    unitCursors = metadata.unitCursors ?? [:]
    retryCount = metadata.retryCount
    maxRetries = metadata.maxRetries
    annotationId = Self.anchor(record)
    self.trace = trace
    self.transport = transport
    self.owner = owner
    self.timing = timing
    let span = Self.startSpan(jobId: metadata.id, jobType: metadata.type, trace: trace)
    workingTrace = traceCarrier(span)
    self.span = Mutex(span)
  }

  deinit {
    endSpan()
    cancelled.finish()
  }

  private static func startSpan(jobId: JobId, jobType: JobType, trace: [String: String]?)
    -> any Span
  {
    let builder = OpenTelemetry.instance.tracerProvider.get(instrumentationName: "Semiont")
      .spanBuilder(spanName: "job:\(jobType.rawValue)")
      .setAttribute(key: "job.id", value: jobId.value)
    if let trace,
      let parent = OpenTelemetry.instance.propagators.textMapPropagator.extract(
        carrier: trace, getter: TraceMap())
    {
      builder.setParent(parent)
    }
    return builder.startSpan()
  }

  private nonisolated func endSpan() {
    span.withLock {
      $0?.end()
      $0 = nil
    }
  }

  private static func anchor(_ record: JobRunning) -> AnnotationId? {
    guard record.metadata.type == .yield, let context = record.params.rest["context"],
      let data = try? JSONEncoder().encode(context),
      let decoded = try? JSONDecoder().decode(GatheredContext.self, from: data),
      case .annotation(let focus) = decoded.focus
    else { return nil }
    return focus.annotation.id
  }

  func signalCancellation() {
    if !settled { cancelled.set(true) }
  }

  private func enter() async {
    if operating {
      await withCheckedContinuation { waiters.append($0) }
    } else {
      operating = true
    }
  }

  private func leave() {
    if waiters.isEmpty {
      operating = false
    } else {
      waiters.removeFirst().resume()
    }
  }

  private func requireUnsettled() throws {
    try Task.checkCancellation()
    if settled { throw BusRequestError(.busRejected, "Job \(jobId.value) is already settled") }
  }

  private func say<Payload>(_ channel: Channel<Payload>, _ payload: Payload) async throws {
    let payload = try wirePayload(payload)
    if let http = transport as? HttpTransport {
      let emission = await http.enqueueEmission(
        channel: channel.name, payload: payload, correlationId: nil, parent: workingTrace)
      _ = try await http.awaitEmission(emission)
    } else {
      _ = try await transport.emit(
        channel: channel.name, payload: payload, scope: nil, correlationId: nil)
    }
  }

  func start() async throws {
    await enter()
    defer { leave() }
    try requireUnsettled()
    guard !begun else { throw BusRequestError(.busRejected, "Job start is its first message") }
    begun = true
    try await say(
      Channels.jobStart,
      JobStartCommand(
        annotationId: annotationId, attempt: attempt, jobId: jobId, jobType: jobType,
        resourceId: resourceId))
  }

  func progress(_ progress: JobProgress) async throws {
    await enter()
    defer { leave() }
    try requireUnsettled()
    begun = true
    await owner?.active()
    var progress = progress
    if let annotationId { progress.annotationId = annotationId }
    try await say(
      Channels.jobReportProgress,
      JobReportProgressCommand(
        annotationId: annotationId, attempt: attempt, jobId: jobId, jobType: jobType,
        percentage: progress.percentage, progress: progress, resourceId: resourceId))
  }

  func checkpoint(
    completedUnits: [String], unitCursors: [String: UnitCursor]? = nil
  ) async throws {
    await enter()
    defer { leave() }
    try requireUnsettled()
    begun = true
    await owner?.active()
    try await say(
      Channels.jobCheckpoint,
      JobCheckpointCommand(completedUnits: completedUnits, jobId: jobId, unitCursors: unitCursors))
  }

  func commit(resourceId: ResourceId, annotations: [Annotation]) async throws {
    await enter()
    defer { leave() }
    try requireUnsettled()
    guard let last = annotations.last else { return }
    do {
      _ = try await workerRequest(
        transport, Operations.markCommit,
        MarkCommitCommand(annotations: annotations, jobId: jobId, resourceId: resourceId),
        timeoutMs: timing.commitTimeoutMs, parent: workingTrace)
      observed(.acknowledged)
    } catch let timeout as BusRequestError where timeout.reason == .busTimeout {
      do {
        _ = try await workerRequest(
          transport, Operations.browseAnnotationRequested,
          BrowseAnnotationRequest(annotationId: last.id, resourceId: resourceId),
          timeoutMs: timing.commitTimeoutMs, parent: workingTrace)
        observed(.probeConfirmed)
      } catch {
        let reason = (error as? BusRequestError)?.reason
        observed(
          reason == .busRejected || reason == .busNotFound ? .probeRefused : .probeUnreachable)
        throw timeout
      }
    }
  }

  private func observed(_ evidence: DurabilityEvidence) {
    if let durability, weakness(durability) >= weakness(evidence) { return }
    durability = evidence
  }

  private func weakness(_ evidence: DurabilityEvidence) -> Int {
    switch evidence {
    case .acknowledged: return 0
    case .probeConfirmed: return 1
    case .probeRefused, .probeUnreachable: return 2
    }
  }

  private func settle<Payload>(
    _ channel: Channel<Payload>, _ payload: Payload, completed: Bool = false
  ) async throws {
    try requireUnsettled()
    settled = true
    do {
      try await say(channel, payload)
    } catch {
      await release(completed: completed)
      throw error
    }
    await release(completed: completed)
  }

  private func release(completed: Bool) async {
    endSpan()
    cancelled.finish()
    await owner?.released(self, completed: completed)
  }

  func fail(
    _ message: String, failureClass: FailureClass? = nil, completedUnits: [String]? = nil,
    unitCursors: [String: UnitCursor]? = nil
  ) async throws {
    await enter()
    defer { leave() }
    let notEstablished = durability.flatMap { weakness($0) == 2 ? $0 : nil }
    try await settle(
      Channels.jobFail,
      JobFailCommand(
        annotationId: annotationId, attempt: attempt, completedUnits: completedUnits,
        durability: notEstablished, error: message, failureClass: failureClass, jobId: jobId,
        jobType: jobType, resourceId: resourceId, unitCursors: unitCursors,
        willRetry: willRetryAfter(
          retryCount: retryCount, maxRetries: maxRetries, failureClass: failureClass)))
  }

  func cancel(
    completedUnits: [String]? = nil, unitCursors: [String: UnitCursor]? = nil
  ) async throws {
    await enter()
    defer { leave() }
    try await settle(
      Channels.jobCancel,
      JobCancelCommand(
        annotationId: annotationId, completedUnits: completedUnits, jobId: jobId, jobType: jobType,
        resourceId: resourceId, unitCursors: unitCursors))
  }
}

extension HeldWork: HeldMarkJob where Result == MarkJobResult {
  func complete(_ result: MarkJobResult) async throws {
    await enter()
    defer { leave() }
    try await settle(
      Channels.jobComplete,
      .markJobCompleteCommand(
        MarkJobCompleteCommand(
          attempt: attempt, durability: durability, jobId: jobId, resourceId: resourceId,
          result: result)),
      completed: true)
  }
}

extension HeldWork: HeldYieldJob where Result == YieldJobResult {
  func complete(_ result: YieldJobResult) async throws {
    await enter()
    defer { leave() }
    try await settle(
      Channels.jobComplete,
      .yieldJobCompleteCommand(
        YieldJobCompleteCommand(
          annotationId: annotationId, attempt: attempt, durability: durability, jobId: jobId,
          resourceId: resourceId, result: result)),
      completed: true)
  }
}
