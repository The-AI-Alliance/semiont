import Foundation
import Synchronization
import Testing

@testable import Semiont

// A worker's claims, told of an announcement its transport refused: it is still one received, so
// it is stamped as heard, and, since no filter can be compared with what cannot be read, it wakes
// the worker as a matching one would.

private func accepted() throws -> [JobFilter] {
  try decoded(
    [JobFilter].self,
    .array([
      .object(["jobType": .string("mark"), "params": .object(["motivation": .string("tagging")])])
    ]))
}

/// An announcement of `job` the transport refused, its payload being no object.
private func refusedAnnouncement(_ job: String) -> Carried {
  .refused(
    FrameRefusal(
      channel: Channels.jobQueued.name, member: "payload", reason: .malformed,
      payload: .string(job), correlationId: nil, scope: nil))
}

private func claimsAsked(_ probe: ProbeTransport) -> Int {
  probe.calls.filter { $0.name == Operations.jobClaim.request.name }.count
}

private func nonePending() -> BusRequestError {
  BusRequestError(.busNonePending, "No pending job matches")
}

/// Until `holds` holds.
private func until(_ holds: @escaping @Sendable () async -> Bool) async throws {
  try await withinTestDeadline {
    while !(await holds()) { try await Task.sleep(for: .milliseconds(5)) }
  }
}

/// How many times it has been asked, this time among them.
private final class Answers: Sendable {
  private let count = Mutex(0)
  func next() -> Int {
    count.withLock {
      $0 += 1
      return $0
    }
  }
}

@Test func aRefusedAnnouncementIsHeardAndClaimsAsAMatchingOneDoes() async throws {
  let probe = ProbeTransport(channels: jobClaimChannels)
  let answers = Answers()
  probe.handle { name, _ in
    #expect(name == Operations.jobClaim.request.name)
    if answers.next() == 1 { throw nonePending() }
    return try jobClaimedFixture("job-8")
  }
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  let claims = client.job.claim(try accepted())
  let reading = Task {
    var jobs = claims.makeAsyncIterator()
    return await jobs.next()?.jobId
  }
  try await until { claimsAsked(probe) == 1 }
  #expect(await claims.vitals.lastQueuedEventAt == nil)
  probe.deliver(refusedAnnouncement("job-8"))
  #expect(try await withinTestDeadline { await reading.value }?.value == "job-8")
  #expect(claimsAsked(probe) == 2)
  #expect(await claims.vitals.lastQueuedEventAt != nil)
  await claims.stop()
}

@Test func aRefusedAnnouncementWhileAClaimIsInFlightEarnsOneMoreClaim() async throws {
  let probe = ProbeTransport(channels: jobClaimChannels)
  let answers = Answers()
  let answer = Watched(false)
  probe.handle { _, _ in
    if answers.next() == 1 {
      for await given in answer where given { break }
    }
    throw nonePending()
  }
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  let claims = client.job.claim(try accepted())
  let reading = Task {
    var jobs = claims.makeAsyncIterator()
    _ = await jobs.next()
  }
  try await until { claimsAsked(probe) == 1 }
  probe.deliver(refusedAnnouncement("job-9"))
  try await until { await claims.vitals.lastQueuedEventAt != nil }
  #expect(claimsAsked(probe) == 1, "one claim is in flight at a time")
  answer.set(true)
  try await until { claimsAsked(probe) == 2 }
  reading.cancel()
  await claims.stop()
}

@Test func aRefusedAnnouncementWhileAJobIsHeldIsHeardAndIgnored() async throws {
  let probe = ProbeTransport(channels: jobClaimChannels)
  let answers = Answers()
  probe.handle { _, _ in
    if answers.next() == 1 { return try jobClaimedFixture("job-1") }
    throw nonePending()
  }
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  let claims = client.job.claim(try accepted())
  var jobs = claims.makeAsyncIterator()
  let job = try #require(await jobs.next())
  probe.deliver(refusedAnnouncement("job-8"))
  try await until { await claims.vitals.lastQueuedEventAt != nil }
  #expect(claimsAsked(probe) == 1)
  try await job.fail("done", failureClass: nil, completedUnits: nil, unitCursors: nil)
  try await until { claimsAsked(probe) == 2 }
  await claims.stop()
  #expect(claimsAsked(probe) == 2, "the settle claims, and nothing was owed")
}
