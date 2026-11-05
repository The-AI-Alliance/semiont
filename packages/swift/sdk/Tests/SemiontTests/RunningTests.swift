import Foundation
import Testing

@testable import Semiont

private struct OperationRefused: Error, Equatable {}
@Test func iteratingAFailedOperationPreservesItsError() async throws {
  let running = Running<Int>(lifetime: Lifetime()) { report in
    report(1)
    throw OperationRefused()
  }
  var reader = running.makeAsyncIterator()
  #expect(try await reader.next() == 1)
  await #expect(throws: OperationRefused.self) { try await reader.next() }
}
@Test func delegationRejectsAMissingCompletionAndDisposesItsWork() async throws {
  let invalid = Delegation<Int>(
    Running(lifetime: Lifetime()) { _ in
      .created(JobCreatedResultResponse(jobId: try JobId("job-1")))
    })
  do {
    _ = try await invalid.completed()
    Issue.record("A delegation without a completion succeeded")
  } catch let error as TransportError {
    #expect(error.reason == .error)
    #expect(error.description.contains("without its completion"))
  }
  let started = Watched(false)
  let waiting = Delegation<Int>(
    Running(lifetime: Lifetime()) { _ in
      started.set(true)
      return .complete(7)
    })
  waiting.dispose()
  await #expect(throws: CancellationError.self) { try await waiting.completed() }
  #expect(!started.value)
}
@Test func nativeFailureProjectionPreservesDeclaredCodesAndRejectsAnAbsentMessage() throws {
  let descriptor = try #require(wireOperations[Operations.frameAddEntityType.request.name])
  let error = try descriptor.decodeFailure(
    wirePayload(CommandError(code: .peerUnavailable, message: "still starting")))
  #expect(error.reason == .busPeerUnavailable)
  #expect(error.description == "still starting")
  #expect(throws: TransportError.self) {
    try projectFailure(BusEmptyPayload.self, [:], stamps: [], messageField: "message")
  }
}

@Test func runningStartsOnDemandAndReportsTheFinalValueOnce() async throws {
  let lifetime = Lifetime()
  let started = Watched(0)
  let running = Running<Int>(lifetime: lifetime) { report in
    started.set(started.value + 1)
    report(1)
    report(2)
    return 3
  }
  #expect(started.value == 0)
  var values: [Int] = []
  for try await value in running { values.append(value) }
  #expect(values == [1, 2, 3])
  #expect(started.value == 1)
  await #expect(throws: MultipleConsumers.self) { try await running.completed() }
}

@Test func runningSurvivesATemporarySequenceAndCancelsOnBreak() async throws {
  let life = Lifetime()
  var values: [Int] = []
  for try await value in Running<Int>(
    lifetime: life,
    work: { report in
      report(1)
      return 2
    })
  { values.append(value) }
  #expect(values == [1, 2])
  let stopped = Watched(false)
  let running = Running<Int>(lifetime: life) { report in
    report(1)
    do { try await sleepMilliseconds(60000) } catch {
      stopped.set(true)
      throw error
    }
    return 2
  }
  for try await _ in running { break }
  try await within(testDeadlineMs) { for await value in stopped where value { return } }
}
private actor OperationGate {
  let started = Watched(false)
  private var continuation: CheckedContinuation<Void, Never>?
  private var released = false
  func wait() async {
    guard !released else { return }
    started.set(true)
    await withCheckedContinuation { continuation = $0 }
  }
  func release() {
    released = true
    continuation?.resume()
    continuation = nil
  }
}
@Test func clientCloseSettlesAnAwaiterEvenWhenWorkCannotCooperate() async throws {
  let life = Lifetime()
  let gate = OperationGate()
  let running = Running<Int>(lifetime: life) { _ in
    await gate.wait()
    return 7
  }
  let outcome = Watched<Result<Int, any Error>?>(nil)
  let waiter = Task {
    do { outcome.set(.success(try await running.completed())) } catch {
      outcome.set(.failure(error))
    }
  }
  defer {
    life.end()
    waiter.cancel()
  }
  do {
    try await within(testDeadlineMs) {
      for await value in gate.started where value { return }
      throw CancellationError()
    }
    life.end()
    let result = try await within(testDeadlineMs) {
      for await value in outcome {
        if let value { return value }
      }
      throw CancellationError()
    }
    switch result {
    case .success: Issue.record("Closed operation completed")
    case .failure(let error as BusRequestError): #expect(error.reason == .busClosed)
    case .failure(let error): Issue.record("Closing the operation raised \(error)")
    }
  } catch {
    Issue.record("Could not observe the operation start and close: \(error)")
  }
  await gate.release()
}
@Test func runningAwaitCancellationStopsOwnedWorkAndRefusesASecondReader() async throws {
  let life = Lifetime()
  let began = Watched(false)
  let stopped = Watched(false)
  let running = Running<Int>(lifetime: life) { _ in
    began.set(true)
    do { try await sleepMilliseconds(60000) } catch {
      stopped.set(true)
      throw error
    }
    return 1
  }
  let waiter = Task { try await running.completed() }
  try await within(testDeadlineMs) { for await value in began where value { return } }
  var second = running.makeAsyncIterator()
  await #expect(throws: MultipleConsumers.self) { try await second.next() }
  waiter.cancel()
  do {
    _ = try await within(testDeadlineMs) { try await waiter.value }
    Issue.record("Cancelled await completed")
  } catch is CancellationError {}
  try await within(testDeadlineMs) { for await value in stopped where value { return } }
}
@Test func gatherOptionsNormalizationHasACensusGate() throws {
  let fields = try required(
    Spec.read("components/schemas/GatherResourceRequestOptions.json").object, "properties"
  ).object
  #expect(
    Set(fields.keys)
      == Set(["depth", "maxResources", "includeContent", "includeSummary", "excludeEntityTypes"]))
}
@Test func operationFailuresReadTheirDeclaredMessageField() throws {
  let descriptor = try #require(wireOperations[Operations.matchSearchRequested.request.name])
  let error = try descriptor.decodeFailure(
    wirePayload(
      MatchSearchFailed(error: "the search was refused", referenceId: AnnotationId("ann-1"))))
  #expect(error.description == "the search was refused")
  #expect(error.reason == unrecognizedBusFailure)
}
@Test func constructingAnOperationOrIteratorSendsNothing() async throws {
  let life = Lifetime()
  let started = Watched(false)
  let running = Running<Int>(lifetime: life) { _ in
    started.set(true)
    return 1
  }
  try await sleepMilliseconds(20)
  #expect(!started.value)
  var iterator = running.makeAsyncIterator()
  try await sleepMilliseconds(20)
  #expect(!started.value)
  #expect(try await iterator.next() == 1)
  #expect(try await iterator.next() == nil)
}
