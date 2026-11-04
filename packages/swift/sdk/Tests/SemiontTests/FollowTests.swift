import Foundation
import Synchronization
import Testing

@testable import Semiont

private actor ReplyGate<Value: Sendable> {
  let started = Watched(false)
  private var value: Value?
  private var continuation: CheckedContinuation<Value, Never>?
  func wait() async -> Value {
    started.set(true)
    if let value { return value }
    return await withCheckedContinuation { continuation = $0 }
  }
  func release(_ value: Value) {
    self.value = value
    continuation?.resume(returning: value)
    continuation = nil
  }
}
private func markParams() throws -> MarkJobParams {
  let table = try Spec.read("client/surface.json").object
  let namespace = try #require(
    required(table, "namespaces").array.first { try $0.object["namespace"] == .string("mark") })
  let method = try #require(
    required(namespace.object, "methods").array.first {
      try $0.object["method"] == .string("delegate")
    })
  let row = try #require(required(method.object, "cases").array.first).object
  return try decoded(MarkJobParams.self, required(required(row, "args").object, "params"))
}
private func progress(_ job: String = "job-1", percentage: Double) throws
  -> JobReportProgressCommand
{
  JobReportProgressCommand(
    jobId: try JobId(job), jobType: .mark, percentage: percentage,
    progress: JobProgress(percentage: percentage), resourceId: try ResourceId("res-1"))
}
private func report<Payload>(_ channel: Channel<Payload>, _ payload: Payload, on bus: EventBus)
  throws
{
  bus.receive(ReceivedFrame(channel: channel.name, payload: try wirePayload(payload)))
}
private func eventName<Value>(_ event: JobEvent<Value>) -> String {
  switch event {
  case .created: "created"
  case .progress: "progress"
  case .failed: "failed"
  case .complete: "complete"
  }
}
@Test func delegationBuffersEarlyFramesAndNamesTheJobFirst() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  let gate = ReplyGate<[String: JSONValue]>()
  let reply = try jobCreatedFixture()
  defer { Task { await gate.release(reply) } }
  probe.handle { [weak client] name, payload in
    #expect(name == Operations.jobCreate.request.name)
    let bus = try #require(client?.bus)
    try report(Channels.jobReportProgress, progress("unrelated", percentage: 90), on: bus)
    bus.receive(ReceivedFrame(channel: Channels.jobReportProgress.name, payload: [:]))
    try report(Channels.jobReportProgress, progress(percentage: 10), on: bus)
    try report(
      Channels.jobComplete, completionFixture(decoded(JobCreateCommand.self, .object(payload))),
      on: bus)
    return await gate.wait()
  }
  let delegation = try client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
  #expect(probe.calls.isEmpty)
  let collecting = Task {
    var events: [JobEvent<MarkJobCompleteCommand>] = []
    for try await event in delegation { events.append(event) }
    return events
  }
  try await within(1000) { for await ready in gate.started where ready { return } }
  await gate.release(reply)
  let events = try await within(1000) { try await collecting.value }
  #expect(events.map(eventName) == ["created", "progress", "complete"])
  guard case .progress(let value) = events[1] else {
    Issue.record("No progress")
    return
  }
  #expect(value.percentage == 10)
  #expect(probe.calls.count == 1)
}
@Test func aRetriedAttemptIsReportedAndNotAnEnd() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  probe.handle { [weak client] _, payload in
    let bus = try #require(client?.bus)
    try report(
      Channels.jobFail,
      JobFailCommand(
        error: "try again", failureClass: .transient,
        jobId: JobId("job-1"), jobType: .mark, resourceId: ResourceId("res-1"), willRetry: true),
      on: bus)
    try report(Channels.jobReportProgress, progress(percentage: 20), on: bus)
    try report(
      Channels.jobComplete, completionFixture(decoded(JobCreateCommand.self, .object(payload))),
      on: bus)
    return try jobCreatedFixture()
  }
  var events: [String] = []
  for try await event in try client.mark.delegate(
    resourceId: ResourceId("res-1"), params: markParams())
  {
    events.append(eventName(event))
  }
  #expect(events == ["created", "failed", "progress", "complete"])
}
@Test func terminalFailurePreservesItsMessageAndClassification() async throws {
  for retry in [nil, false] as [Bool?] {
    let probe = ProbeTransport()
    let client = try await SemiontClient(transport: probe)
    defer { client.dispose() }
    probe.handle { [weak client] _, _ in
      try report(
        Channels.jobFail,
        JobFailCommand(
          error: "the model refused", failureClass: .withheld,
          jobId: JobId("job-1"), jobType: .mark, resourceId: ResourceId("res-1"), willRetry: retry),
        on: #require(client?.bus))
      return try jobCreatedFixture()
    }
    do {
      _ = try await within(1000) {
        try await client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
          .completed()
      }
      Issue.record("A failed job completed")
    } catch let error as JobError {
      #expect(error.reason == .jobFailed)
      #expect(error.description == "the model refused")
      #expect(error.failureClass == .withheld)
      #expect(error.jobId?.value == "job-1")
    }
  }
}
@Test func silencePollsOneAtATimeAndRecoversAnUnheardEnd() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(
    transport: probe, followTiming: FollowTiming(silenceMs: 5, statusPollMs: 5))
  defer { client.dispose() }
  let polls = Mutex(0)
  let inFlight = Mutex(0)
  probe.handle { name, _ in
    if name == Operations.jobCreate.request.name { return try jobCreatedFixture() }
    #expect(name == Operations.jobStatusRequested.request.name)
    let now = inFlight.withLock {
      $0 += 1
      return $0
    }
    #expect(now == 1)
    defer { inFlight.withLock { $0 -= 1 } }
    try await sleepMilliseconds(20)
    let count = polls.withLock {
      $0 += 1
      return $0
    }
    if count == 1 { throw TransportError(.unavailable, "offline") }
    return try wirePayload(JobStatusResult(response: statusFixture()))
  }
  let complete = try await within(1000) {
    try await client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
      .completed()
  }
  #expect(complete.jobId.value == "job-1")
  #expect(polls.withLock { $0 } == 2)
}
@Test func aStaleStatusCannotEndTheAttemptThatFollowsASetback() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(
    transport: probe, followTiming: FollowTiming(silenceMs: 5, statusPollMs: 5))
  defer { client.dispose() }
  let gate = ReplyGate<[String: JSONValue]>()
  let stale = try wirePayload(
    JobStatusResult(response: statusFixture(status: .failed, error: "old attempt")))
  defer { Task { await gate.release(stale) } }
  probe.handle { name, _ in
    if name == Operations.jobCreate.request.name { return try jobCreatedFixture() }
    return await gate.wait()
  }
  let following = try client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
  let observed = Watched(0)
  let collecting = Task {
    for try await event in following {
      if case .failed = event { observed.set(1) }
      if case .complete(let value) = event { return value }
    }
    throw SpecFailure.shape("Missing completion")
  }
  try await within(1000) { for await ready in gate.started where ready { return } }
  try report(
    Channels.jobFail,
    JobFailCommand(
      error: "retry", jobId: JobId("job-1"), jobType: .mark,
      resourceId: ResourceId("res-1"), willRetry: true), on: client.bus)
  try await within(1000) { for await value in observed where value == 1 { return } }
  await gate.release(stale)
  try await sleepMilliseconds(20)
  try report(
    Channels.jobComplete,
    JobCompleteCommand.markJobCompleteCommand(
      MarkJobCompleteCommand(jobId: JobId("job-1"), resourceId: ResourceId("res-1"))),
    on: client.bus)
  #expect(try await within(1000) { try await collecting.value }.jobId.value == "job-1")
}
@Test func statusReportsCancellationAndFailureAndRejectsTheWrongVerb() async throws {
  for state in [JobStatusResponseStatus.cancelled, .failed, .complete] {
    let probe = ProbeTransport()
    let client = try await SemiontClient(
      transport: probe, followTiming: FollowTiming(silenceMs: 1, statusPollMs: 1))
    defer { client.dispose() }
    probe.handle { name, _ in
      if name == Operations.jobCreate.request.name { return try jobCreatedFixture() }
      return try wirePayload(
        JobStatusResult(
          response: statusFixture(
            kind: state == .complete ? .yield : .mark, status: state, error: "failed")))
    }
    do {
      _ = try await within(1000) {
        try await client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
          .completed()
      }
      Issue.record("An invalid end succeeded")
    } catch let error as JobError {
      #expect(state != .complete)
      #expect(error.reason == (state == .cancelled ? .jobCancelled : .jobFailed))
    } catch let error as TransportError {
      #expect(state == .complete)
      #expect(error.reason == .error)
    }
  }
}
@Test func generationStallCancelsTheNamedJobAndEndsAsStalled() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(
    transport: probe, followTiming: FollowTiming(silenceMs: 1000, statusPollMs: 1000))
  defer { client.dispose() }
  let cancelled = Watched(false)
  probe.handle { name, _ in
    if name == Operations.jobCreate.request.name { return try jobCreatedFixture() }
    #expect(name == Operations.jobCancelRequested.request.name)
    cancelled.set(true)
    return try wirePayload(ResponseEnvelope(response: JobCancelResult(cancelled: true)))
  }
  let params = try GenerationJobParams(
    context: contextFixture(), storageUri: "file://notes.md", title: "Notes")
  do {
    _ = try await within(1000) {
      try await client.yield.delegate(params: params, stallDeadlineMs: 100).completed()
    }
    Issue.record("A silent job completed")
  } catch let error as JobError {
    #expect(error.reason == .jobStalled)
    #expect(error.jobId?.value == "job-1")
  }
  try await within(1000) { for await ready in cancelled where ready { return } }
}
@Test func progressRestartsAGenerationStallDeadline() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(
    transport: probe, followTiming: FollowTiming(silenceMs: 60000, statusPollMs: 60000))
  defer { client.dispose() }
  let began = Watched(false)
  probe.handle { _, _ in
    began.set(true)
    return try jobCreatedFixture()
  }
  let params = try GenerationJobParams(
    context: contextFixture(), storageUri: "file://notes.md", title: "Notes")
  let following = try client.yield.delegate(params: params, stallDeadlineMs: 400)
  let collector = Task { try await following.completed() }
  try await within(1000) { for await ready in began where ready { return } }
  for _ in 0..<3 {
    try await sleepMilliseconds(150)
    try report(
      Channels.jobReportProgress,
      JobReportProgressCommand(
        jobId: JobId("job-1"), jobType: .yield, percentage: 10, resourceId: ResourceId("res-1")),
      on: client.bus)
  }
  try report(
    Channels.jobComplete,
    JobCompleteCommand.yieldJobCompleteCommand(
      YieldJobCompleteCommand(jobId: JobId("job-1"), resourceId: ResourceId("res-1"))),
    on: client.bus)
  #expect(try await within(1000) { try await collector.value }.jobId.value == "job-1")
}
@Test func cancellingAFollowerStopsFollowingWithoutCancellingItsJob() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  let created = Watched(false)
  probe.handle { _, _ in
    created.set(true)
    return try jobCreatedFixture()
  }
  let following = try client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
  let waiter = Task { try await following.completed() }
  try await within(1000) { for await ready in created where ready { return } }
  waiter.cancel()
  do {
    _ = try await within(1000) { try await waiter.value }
    Issue.record("Cancelled follower completed")
  } catch is CancellationError {}
  #expect(probe.calls.map(\.name) == [Operations.jobCreate.request.name])
}
private struct UnexpectedStatusFailure: Error {}
@Test func unexpectedStatusFailuresAndWrongCompletionFramesReachTheCaller() async throws {
  for wrongFrame in [false, true] {
    let probe = ProbeTransport()
    let client = try await SemiontClient(
      transport: probe, followTiming: FollowTiming(silenceMs: 1, statusPollMs: 1))
    defer { client.dispose() }
    probe.handle { [weak client] name, _ in
      if name == Operations.jobCreate.request.name {
        if wrongFrame {
          try report(
            Channels.jobComplete,
            JobCompleteCommand.yieldJobCompleteCommand(
              YieldJobCompleteCommand(jobId: JobId("job-1"), resourceId: ResourceId("res-1"))),
            on: #require(client?.bus))
        }
        return try jobCreatedFixture()
      }
      throw UnexpectedStatusFailure()
    }
    do {
      _ = try await within(1000) {
        try await client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
          .completed()
      }
      Issue.record("Invalid follower completed")
    } catch is UnexpectedStatusFailure { #expect(!wrongFrame) } catch let error as TransportError {
      #expect(wrongFrame)
      #expect(error.reason == .error)
    }
  }
}
@Test func jobPollingReportsEveryStatusUntilCompletion() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  let calls = Mutex(0)
  probe.handle { _, _ in
    let count = calls.withLock {
      $0 += 1
      return $0
    }
    return try wirePayload(
      JobStatusResult(response: statusFixture(status: count == 1 ? .pending : .complete)))
  }
  let statuses = Mutex<[JobStatusResponseStatus]>([])
  _ = try await client.job.pollUntilComplete(JobId("job-1"), intervalMs: 1, timeoutMs: 10000) {
    value in statuses.withLock { $0.append(value.status) }
  }
  #expect(statuses.withLock { $0 } == [.pending, .complete])
  #expect(probe.calls.count == 2)
}
@Test(arguments: [false, true])
func jobPollingDeadlineBoundsRequestsAndIntervals(unanswered: Bool) async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  let requestEnded = Watched(false)
  probe.handle { _, _ in
    defer { requestEnded.set(true) }
    if unanswered { try await sleepMilliseconds(60000) }
    return try wirePayload(JobStatusResult(response: statusFixture(status: .pending)))
  }
  do {
    _ = try await within(5000) {
      try await client.job.pollUntilComplete(JobId("job-1"), intervalMs: 60000, timeoutMs: 2000)
    }
    Issue.record("Unanswered polling succeeded")
  } catch let error as BusRequestError { #expect(error.reason == .busTimeout) }
  #expect(requestEnded.value)
  #expect(probe.calls.count == 1)
}
@Test func learnedCompletionUsesOnlyTheDelegatedVerbsResult() throws {
  var status = try statusFixture()
  status.result = .jobResult(.markJobDone(MarkJobDone(found: 7, persisted: 4)))
  let completion = try MarkJobCompleteCommand.learned(status, resource: ResourceId("res-1"))
  guard case .markJobDone(let result) = completion.result else {
    Issue.record("Wrong result")
    return
  }
  #expect(result.found == 7 && result.persisted == 4)
  #expect(throws: TransportError.self) {
    try YieldJobCompleteCommand.learned(status, resource: ResourceId("res-1"))
  }
  status.type = .yield
  #expect(throws: TransportError.self) {
    try YieldJobCompleteCommand.learned(status, resource: ResourceId("res-1"))
  }
}
@Test func generationDeadlineUsesTheGeneratedTimingAndRefusesAnUnrepresentableLength() throws {
  #expect(
    try generationStallDeadline(maxTokens: nil)
      == max(
        Timings.generationStallFloorMs,
        Timings.generationStallAssumedTokensCount * Timings.generationStallPerTokenMs))
  #expect(try generationStallDeadline(maxTokens: -1) == Timings.generationStallFloorMs)
  #expect(
    try generationStallDeadline(maxTokens: 100000) == 100000 * Timings.generationStallPerTokenMs)
  #expect(throws: TransportError.self) { try generationStallDeadline(maxTokens: .infinity) }
}

@Test func learnedCompletionsPreserveYieldResultsAndDeclines() throws {
  let resource = try ResourceId("res-1")
  let generated = YieldJobDone(
    resourceId: try ResourceId("res-new"), resourceName: "Generated", truncated: true)
  var status = try statusFixture(kind: .yield)
  status.result = .jobResult(.yieldJobDone(generated))
  let completion = try YieldJobCompleteCommand.learned(status, resource: resource)
  #expect(completion.jobId == status.jobId && completion.resourceId == resource)
  guard case .yieldJobDone(let result) = completion.result else {
    Issue.record("Yield result lost")
    return
  }
  #expect(result.resourceId == generated.resourceId)
  #expect(result.resourceName == generated.resourceName && result.truncated)
  status.type = .mark
  #expect(throws: TransportError.self) {
    try MarkJobCompleteCommand.learned(status, resource: resource)
  }
  status.type = .yield
  let declined = JobDeclined(reason: .encrypted)
  status.result = .jobResult(.jobDeclined(declined))
  guard
    case .jobDeclined(let yieldDecline) = try YieldJobCompleteCommand.learned(
      status, resource: resource
    ).result
  else {
    Issue.record("Yield decline lost")
    return
  }
  #expect(yieldDecline.reason == declined.reason)
  status.type = .mark
  guard
    case .jobDeclined(let markDecline) = try MarkJobCompleteCommand.learned(
      status, resource: resource
    ).result
  else {
    Issue.record("Mark decline lost")
    return
  }
  #expect(markDecline.reason == declined.reason)
}
@Test func followingRefusesAnotherJobsStatusAndExposesItsFailureCode() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(
    transport: probe, followTiming: FollowTiming(silenceMs: 1, statusPollMs: 1))
  defer { client.dispose() }
  probe.handle { name, _ in
    if name == Operations.jobCreate.request.name { return try jobCreatedFixture() }
    return try wirePayload(JobStatusResult(response: statusFixture("another-job")))
  }
  do {
    _ = try await within(5000) {
      try await client.mark.delegate(resourceId: ResourceId("res-1"), params: markParams())
        .completed()
    }
    Issue.record("Another job's status completed the delegation")
  } catch let error as TransportError {
    #expect(error.reason == .error)
    #expect(error.description.contains("not the followed job"))
  }
  let failed = JobError(
    reason: .jobFailed, description: "failed", jobId: try JobId("job-1"), failureClass: .transient)
  #expect(failed.code == failed.reason.rawValue)
}
