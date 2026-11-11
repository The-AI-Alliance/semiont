import Foundation
import SemiontTesting
import Synchronization
import Testing

@testable import Semiont

@Test func sessionSignalsDeliverRepeatedNotices() async throws {
  let signals = SessionSignals()
  var reader = signals.sessionEnded.makeAsyncIterator()
  _ = await reader.next()
  signals.notifySessionEnded(.expired)
  signals.notifySessionEnded(.expired)
  signals.dispose()
  #expect(await reader.next()??.reason == .expired)
  #expect(await reader.next()??.reason == .expired)
  if case .some = await reader.next() { Issue.record("Signal did not end") }
}

@Test func stateUnitsRunEverySharedCase() async throws {
  let table = try Spec.read("client/state-units.json").object
  let fixtures = try required(table, "fixtures").object
  let cases = try required(table, "cases").array
  let surface = try Spec.read("client/surface.json").object
  let swiftUnits = Set(
    try required(surface, "stateUnits").array.compactMap { value in
      let row = try value.object
      guard try row["made"]?.object["swift"] != nil else { return nil as String? }
      return try required(row, "unit").text
    })
  var run: Set<String> = []
  var ended: [(name: String, executor: CaseExecutor)] = []
  for value in cases {
    let row = try expanded(value, fixtures: fixtures).object
    let kind = try required(row, "unit").text
    guard swiftUnits.contains(kind) else { continue }
    let name = try required(row, "case").text
    let steps = try required(row, "steps").array
    // Each case runs on a thread of its own, so its settle sees everything the case made ready.
    let executor = CaseExecutor()
    ended.append(("\(kind): \(name)", executor))
    defer { executor.stop() }
    do {
      try await executor.run {
        let harness = try await StateCase(row, kind: kind, name: name, executor: executor)
        var failure: (any Error)?
        do {
          for step in steps { try await harness.step(step) }
        } catch {
          failure = error
        }
        await harness.close()
        if let failure { throw failure }
      }
      run.insert(kind)
    } catch {
      Issue.record("\(kind): \(name) — \(error)")
    }
  }
  // A job is late only once its case's thread has ended, so each case is held to none once every
  // case has run: the longest any could take to come.
  for (name, executor) in ended {
    #expect(executor.late == 0, "\(name) — jobs made ready after the case ended")
  }
  // Cache and session are held by their own case tables.
  #expect(run == swiftUnits.subtracting(["cache", "session"]))
}

private final class StateCaseHeard: Sendable {
  private let frames = Mutex<[Carried]>([])

  func append(_ carried: Carried) { frames.withLock { $0.append(carried) } }

  func take() -> [Carried] {
    frames.withLock { frames in
      let taken = frames
      frames.removeAll()
      return taken
    }
  }
}

private final class StateCase {
  let name: String
  let client: SemiontClient
  let wire: StateCaseWire
  let clock = TestClock()
  let search = StateCaseSearch()
  let units: [String: StateCaseUnit]
  let heard = StateCaseHeard()
  let listening: Task<Void, Never>
  let executor: CaseExecutor

  init(_ row: [String: JSONValue], kind: String, name: String, executor: CaseExecutor) async throws
  {
    self.name = "\(kind): \(name)"
    self.executor = executor
    let clock = clock
    let search = search
    let wire = try StateCaseWire(required(row, "transport").object, clock: clock)
    self.wire = wire
    let client = try await SemiontClient(
      transport: wire.transport, clock: clock)
    self.client = client
    let channels = try row["listen"]?.array.map { try $0.text } ?? []
    let heard = heard
    let frames = client.bus.listen(channels)
    listening = spawn {
      do {
        for try await carried in frames { heard.append(carried) }
      } catch {}
    }
    units = try required(row, "made").object.mapValues {
      try StateCaseUnit(kind, options: $0.object, client: client, clock: clock, search: search)
    }
  }

  /// Disposes the case and lets what that makes ready run, then holds it to having run all its
  /// work on its executor.
  func close() async {
    for subject in units.values { subject.unit.dispose() }
    listening.cancel()
    client.dispose()
    await settle()
    #expect(clock.strays == 0, "\(name) — sleeps begun off the case's executor")
    #expect(wire.transport.strays == 0, "\(name) — wire calls made off the case's executor")
    #expect(search.strays == 0, "\(name) — searches asked off the case's executor")
  }

  /// Lets what is ready run, and what that makes ready, until nothing more is. Time in the case
  /// moves only when the scripted clock does.
  private func settle() async { await executor.settle() }

  /// Settles, then moves the clock by `duration` to each instant a sleeper waits for in turn,
  /// settling after each, as what falls due runs to its end.
  private func pass(_ duration: Duration) async {
    let until = clock.now.advanced(by: duration)
    await settle()
    while clock.wakeNext(through: until) { await settle() }
  }

  func step(_ value: JSONValue) async throws {
    if value == .string("settle") {
      await settle()
      return
    }
    let row = try value.object
    if let duration = row["pass"] {
      await pass(try stateCaseDuration(duration))
    } else if let channel = row["say"] ?? row["deliver"] {
      let frame = Carried.frame(
        ReceivedFrame(
          channel: try channel.text, correlationId: try row["correlationId"]?.text,
          payload: try required(row, "payload").object))
      if row["say"] != nil {
        client.bus.receive(frame)
      } else {
        wire.transport.deliver(frame)
      }
    } else if let request = row["answer"] {
      await settle()
      try await wire.reply(
        to: request.text, nth: stateCaseInteger(required(row, "nth")),
        on: required(row, "reply").text,
        payload: required(row, "payload").object, bus: client.bus)
    } else if let queue = row["queueReply"] {
      try wire.queue(queue.text, required(row, "response").object)
    } else if let method = row["invoke"] {
      let unit = try subject(required(row, "of").text)
      try unit.invoke(method.text, args: required(row, "args").object)
    } else if let expect = row["expect"] {
      try checkState(expect.object)
    } else if let ended = row["ended"] {
      for (unit, members) in try ended.object {
        for member in try members.array {
          let reading = try state(unit, member.text)
          #expect(try await reading.ended(), "\(name) — \(unit).\(member) should end")
        }
      }
    } else if let dispose = row["dispose"] {
      try subject(dispose.text).unit.dispose()
    } else if let sent = row["sent"] {
      let channel = try sent.text
      let expected = row["payloads"]
      let count = try row["count"].map(stateCaseInteger) ?? expected?.array.count ?? 0
      await settle()
      let requests = wire.transport.calls.filter { $0.via == "request" && $0.name == channel }
      if let expected {
        check(.array(requests.map { .object($0.payload) }), expected, channel)
      } else {
        #expect(requests.count == count, "\(name) — \(channel)")
      }
    } else if row["nothingSent"] != nil {
      #expect(wire.transport.calls.isEmpty, "\(name) — nothing sent")
    } else if let expected = row["heard"] {
      await settle()
      try checkHeard(try expected.array)
    } else if let destroyed = row["busDestroyed"] {
      let open = (try? client.bus.emit(Channels.yieldClone, BusEmptyPayload())) != nil
      #expect(.bool(!open) == destroyed, "\(name) — client bus")
    } else if let queried = row["searched"] {
      check(try encoded(search.queries), queried, "search queries")
    } else if let answer = row["answerSearch"] {
      try search.answer(
        stateCaseInteger(answer), with: decoded([String]?.self, required(row, "results")))
    } else {
      throw SpecFailure.shape("Unknown step \(row.keys.sorted())")
    }
  }

  private func checkState(_ expected: [String: JSONValue]) throws {
    for (unit, fields) in expected {
      for (member, expectation) in try fields.object {
        let actual = try state(unit, member).value()
        var comparison = expectation
        if member == "error" || member == "resourceError" || member == "failure",
          case .object(let object) = expectation
        {
          comparison = .object(["$has": .object(object)])
        }
        check(actual, comparison, "\(unit).\(member)")
      }
    }
  }

  private func checkHeard(_ expected: [JSONValue]) throws {
    let actual = heard.take()
    #expect(actual.count == expected.count, "\(name) — heard \(actual.map(\.channel))")
    for (carried, value) in zip(actual, expected) {
      guard case .frame(let frame) = carried else {
        Issue.record("\(name) — heard a refused frame on \(carried.channel)")
        continue
      }
      let fields = try value.object
      #expect(frame.channel == (try required(fields, "channel").text), "\(name) — channel heard")
      check(.object(frame.payload), try required(fields, "payload"), frame.channel)
      var id: String?
      if let correlation = fields["correlationId"] {
        if case .object(let sent) = correlation {
          id = try stateCaseCorrelation(
            required(sent, "sent").text, stateCaseInteger(required(sent, "nth")))
        } else {
          id = try correlation.text
        }
      }
      #expect(frame.correlationId == id, "\(name) — \(frame.channel) correlation")
    }
  }

  private func subject(_ unit: String) throws -> StateCaseUnit {
    guard let subject = units[unit] else { throw SpecFailure.shape("Unknown subject \(unit)") }
    return subject
  }

  private func state(_ unit: String, _ member: String) throws -> StateReading {
    guard let reading = try subject(unit).reading[member] else {
      throw SpecFailure.shape("Unknown state \(unit).\(member)")
    }
    return reading
  }

  private func check(_ actual: JSONValue, _ expected: JSONValue, _ label: String) {
    #expect(
      stateCaseMatches(actual, expected), "\(name) — \(label) read \(actual), expected \(expected)")
  }
}

func stateCaseInteger(_ value: JSONValue) throws -> Int {
  guard case .number(let number) = value, let exact = Int(exactly: number) else {
    throw SpecFailure.shape("Expected an integer")
  }
  return exact
}

func stateCaseDuration(_ value: JSONValue) throws -> Duration {
  if case .number = value { return .milliseconds(try stateCaseInteger(value)) }
  let expression = try value.object
  // A retry budget's member follows its budget and a `.`.
  let name = try required(expression, "timing").text.split(separator: ".").map(String.init)
  let table = try Spec.read("client/timing.json").object
  let timings = try required(table, "timing").array.map { try $0.object }
  guard let row = try timings.first(where: { try required($0, "name").text == name[0] }) else {
    throw SpecFailure.shape("Unknown timing \(name[0])")
  }
  var stated = try required(row, "value")
  for member in name.dropFirst() { stated = try required(stated.object, member) }
  let base = try stateCaseInteger(stated)
  let factor = try expression["times"].map { try decoded(Double.self, $0) } ?? 1
  let extra = try expression["plusMs"].map(stateCaseInteger) ?? 0
  return .milliseconds(Double(base) * factor + Double(extra))
}

private func stateCaseMatches(_ actual: JSONValue, _ expected: JSONValue) -> Bool {
  switch (actual, expected) {
  case (.object(let actual), .object(let expected)):
    if case .object(let subset) = expected["$has"] {
      return subset.allSatisfy { key, value in
        actual[key].map { stateCaseMatches($0, value) } == true
      }
    }
    return actual.count == expected.count
      && expected.allSatisfy { key, value in
        actual[key].map { stateCaseMatches($0, value) } == true
      }
  case (.array(let actual), .array(let expected)):
    return actual.count == expected.count && zip(actual, expected).allSatisfy(stateCaseMatches)
  default: return actual == expected
  }
}
