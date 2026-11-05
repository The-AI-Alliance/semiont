import Foundation
import SemiontTesting
import Synchronization

@testable import Semiont

final class StateCaseWire: Sendable {
  private struct Script: Sendable {
    var replies: [String: [[String: JSONValue]]]
    var waiting: [String: [SharedWait<[String: JSONValue]>]] = [:]
    var jobs: [String: JSONValue] = [:]
  }

  let transport = ProbeTransport()
  private let clock: TestClock
  private let mode: String
  private let delay: Duration
  private let script: Mutex<Script>

  init(_ options: [String: JSONValue], clock: TestClock) throws {
    self.clock = clock
    mode = try required(options, "answers").text
    delay = .milliseconds(try options["delayMs"].map(stateCaseInteger) ?? 0)
    let queued = try options["replies"]?.object ?? [:]
    script = Mutex(Script(replies: try queued.mapValues { try $0.array.map { try $0.object } }))
    transport.handle { [weak self] channel, payload in
      guard let self else { throw CancellationError() }
      return try await self.request(channel, payload: payload)
    }
  }

  func queue(_ channel: String, _ response: [String: JSONValue]) {
    script.withLock { $0.replies[channel, default: []].append(response) }
  }

  func reply(
    to channel: String, nth: Int, on reply: String, payload: [String: JSONValue], bus: EventBus
  ) async throws {
    let descriptor = try requiredOperation(channel)
    let result: Result<[String: JSONValue], any Error>
    if reply == descriptor.failure {
      result = .failure(try descriptor.decodeFailure(payload))
    } else if reply == descriptor.result {
      result = .success(payload)
    } else {
      throw SpecFailure.shape("Invalid reply \(reply) to \(channel)")
    }
    let request = try await within(testDeadlineMs) {
      while true {
        if let request = self.script.withLock({ $0.waiting[channel]?.dropFirst(nth).first }) {
          return request
        }
        try await Task.sleep(for: .milliseconds(2))
      }
    }
    let correlation = stateCaseCorrelation(channel, nth)
    let frames = bus.listen([reply])
    defer { frames.dispose() }
    transport.deliver(ReceivedFrame(channel: reply, correlationId: correlation, payload: payload))
    // Model a wire that delivers the frame before resuming the request waiter.
    try await within(testDeadlineMs) {
      for try await frame in frames where frame.correlationId == correlation { return }
      throw CancellationError()
    }
    request.resolve(result)
  }

  private func request(_ channel: String, payload: [String: JSONValue]) async throws
    -> [String: JSONValue]
  {
    let descriptor = try requiredOperation(channel)
    let wait = SharedWait<[String: JSONValue]>()
    let (index, answer) = script.withLock { script in
      let index = script.waiting[channel, default: []].count
      script.waiting[channel, default: []].append(wait)
      var answer: [String: JSONValue]?
      if let first = script.replies[channel]?.first {
        answer = first
        script.replies[channel]?.removeFirst()
      } else if mode == "jobs" {
        switch channel {
        case Channels.jobCreate.name:
          answer = ["jobId": .string("job-1")]
        case Channels.jobStatusRequested.name:
          let id = payload["jobId"] ?? .string("job-1")
          let type = (try? id.text).flatMap { script.jobs[$0] } ?? .string("mark")
          answer = [
            "jobId": id, "type": type, "status": .string("running"),
            "userId": .string("did:web:kb.test:users:person"),
            "created": .string("2026-10-01T00:00:00.000Z"),
          ]
        default: break
        }
      }
      if channel == Channels.jobCreate.name, let type = payload["jobType"],
        let id = try? answer?["jobId"]?.text
      {
        script.jobs[id] = type
      }
      return (index, answer)
    }
    if let answer {
      if delay > .zero { try await clock.sleep(for: delay) }
      let payload: [String: JSONValue] =
        switch channel {
        case Channels.jobCreate.name, Channels.jobStatusRequested.name,
          Channels.markCreateRequest.name:
          ["response": .object(answer)]
        default: answer
        }
      transport.deliver(
        ReceivedFrame(
          channel: descriptor.result, correlationId: stateCaseCorrelation(channel, index),
          payload: payload))
      return payload
    }
    guard mode == "never" else {
      throw BusRequestError(.busRejected, "The test transport refused \(channel)")
    }
    let deadline = clock.now.advanced(by: .milliseconds(Timings.busRequestTimeoutMs))
    let timeout = Task { [clock] in
      do {
        try await clock.sleep(until: deadline, tolerance: nil)
        wait.resolve(.failure(BusRequestError(.busTimeout, "\(channel) timed out")))
      } catch {}
    }
    defer { timeout.cancel() }
    return try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { wait.install($0) }
    } onCancel: {
      wait.resolve(.failure(CancellationError()))
    }
  }

  private func requiredOperation(_ name: String) throws -> WireOperation {
    guard let descriptor = wireOperations[name] else {
      throw SpecFailure.shape("Unknown operation \(name)")
    }
    return descriptor
  }
}

func stateCaseCorrelation(_ channel: String, _ index: Int) -> String { "\(channel)/\(index)" }
