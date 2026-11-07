import Foundation
import Testing

@testable import Semiont
@testable import SemiontTesting

// A request's deadline is its bus's, whatever the transport, measured on the client's clock: a
// request over a transport its caller wrote, which never answers, fails at its deadline and not a
// millisecond before, in every SDK's words. A worker's claim waits its own deadline, through the
// same place.

/// A transport its caller wrote, which never answers a request until the request is abandoned.
private func unanswering() -> ProbeTransport {
  let probe = ProbeTransport()
  probe.handle { operation, _ in
    try await Task.sleep(for: .seconds(3600))
    throw SpecFailure.shape("The transport answered \(operation)")
  }
  return probe
}

/// What `request` fails with once `clock` reaches `deadline`. Moved first to a millisecond before
/// it, the clock still holds the wait for it, and `settled` stays unset.
private func failure(
  of request: Task<Void, any Error>, settled: Watched<Bool>, at deadline: TestClock.Instant,
  on clock: TestClock
) async throws -> (any Error)? {
  try await sleeping(clock, until: deadline)
  clock.advance(by: clock.now.duration(to: deadline) - .milliseconds(1))
  try await Task.sleep(for: .milliseconds(20))
  #expect(clock.wakes.contains(deadline), "the deadline was let go before it fell due")
  #expect(!settled.value, "the request settled before its deadline")
  clock.advance(by: .milliseconds(1))
  do {
    try await withinTestDeadline { try await request.value }
    return nil
  } catch {
    return error
  }
}

@Test(arguments: [nil, 7000] as [Int?])
func aRequestNobodyAnswersFailsAtItsDeadlineOnTheClientsClock(timeoutMs: Int?) async throws {
  let clock = TestClock()
  let client = try await SemiontClient(transport: unanswering(), clock: clock)
  defer { client.dispose() }
  let waited = timeoutMs ?? Timings.busRequestTimeoutMs
  let deadline = clock.now.advanced(by: .milliseconds(waited))
  let settled = Watched(false)
  let request = Task {
    defer { settled.set(true) }
    _ = try await client.wire.request(
      Operations.browseKbRequested, BrowseKbRequest(), timeoutMs: timeoutMs)
  }
  let error = try await failure(of: request, settled: settled, at: deadline, on: clock)
  let timedOut = try #require(
    error as? BusRequestError, "it failed with \(String(describing: error))")
  #expect(timedOut.reason == .busTimeout)
  #expect(
    timedOut.description
      == "Bus request timed out after \(waited)ms on \(Operations.browseKbRequested.result.name)")
}

@Test func aClaimNobodyAnswersIsRefusedAtTheClaimsOwnDeadlineOnTheClientsClock() async throws {
  let clock = TestClock()
  let client = try await SemiontClient(transport: unanswering(), clock: clock)
  defer { client.dispose() }
  let claimTimeoutMs = 7000
  let claims = client.job.claim(
    try decoded(
      [JobFilter].self,
      .array([
        .object([
          "jobType": .string("mark"), "params": .object(["motivation": .string("tagging")]),
        ])
      ])), timing: WorkerTiming(claimTimeoutMs: claimTimeoutMs))
  let refusals = claims.refused()
  let reading = Task {
    var jobs = claims.makeAsyncIterator()
    _ = await jobs.next()
  }
  let settled = Watched(false)
  let refused = Task {
    defer { settled.set(true) }
    var heard = refusals.makeAsyncIterator()
    guard let refusal = try await heard.next() else {
      throw SpecFailure.shape("The claims ended without a refusal")
    }
    throw refusal
  }
  let error = try await failure(
    of: refused, settled: settled, at: clock.now.advanced(by: .milliseconds(claimTimeoutMs)),
    on: clock)
  let refusal = try #require(error as? ClaimRefusal, "it failed with \(String(describing: error))")
  #expect(refusal.code == .busTimeout)
  #expect(
    refusal.detail
      == "Bus request timed out after \(claimTimeoutMs)ms on \(Operations.jobClaim.result.name)")
  reading.cancel()
  await claims.stop()
}
