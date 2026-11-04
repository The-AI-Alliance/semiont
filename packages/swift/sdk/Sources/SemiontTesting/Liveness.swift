import Foundation
import Semiont

/// Each closure waits until one output has spoken or one awaited path has settled.
public struct LivenessScenario: Sendable {
  public let outputs: [@Sendable () async -> Void]
  public let settlements: [@Sendable () async -> Void]
  public let dispose: @Sendable () -> Void

  public init(
    outputs: [@Sendable () async -> Void], settlements: [@Sendable () async -> Void],
    dispose: @escaping @Sendable () -> Void
  ) {
    self.outputs = outputs
    self.settlements = settlements
    self.dispose = dispose
  }
}

public struct LivenessSpec: Sendable {
  public let setup: @Sendable (ScriptedTransport) async throws -> LivenessScenario
  public let respond: Respond
  public let timeout: Duration
  public let retryBudget: Int
  public let schedules: [[FaultAction]]

  public init(
    timeout: Duration, retryBudget: Int, schedules: [[FaultAction]],
    respond: @escaping Respond,
    setup: @escaping @Sendable (ScriptedTransport) async throws -> LivenessScenario
  ) {
    self.timeout = timeout
    self.retryBudget = retryBudget
    self.schedules = schedules
    self.respond = respond
    self.setup = setup
  }
}

public struct AxiomViolation: Error, Sendable, CustomStringConvertible {
  public let description: String
  init(_ description: String) { self.description = description }
}

public func faultActions(using random: inout some RandomNumberGenerator) -> FaultAction {
  switch Int.random(in: 0..<5, using: &random) {
  case 0: .deliver
  case 1: .dropReply
  case 2: .delay(.milliseconds(Int.random(in: 0...5, using: &random)))
  case 3: .duplicateReply
  default: .rejectEmit
  }
}

public func faultSchedules(_ count: Int) -> [[FaultAction]] {
  precondition(count >= 0)
  var random = ScheduleRandom()
  return (0..<count).map { _ in
    (0..<Int.random(in: 1...8, using: &random)).map { _ in faultActions(using: &random) }
  }
}

/// Runs the output, settlement and retry axioms on each fresh composition.
public func assertLivenessAxioms(_ spec: LivenessSpec) async throws {
  guard !spec.schedules.isEmpty, spec.retryBudget >= 0, spec.retryBudget != Int.max,
    spec.timeout > .zero
  else { throw AxiomViolation("Liveness needs a timeout, retry budget and at least one schedule") }

  for schedule in spec.schedules {
    let transport = ScriptedTransport(
      schedule: schedule, timeout: spec.timeout, respond: spec.respond)
    defer { transport.dispose() }
    let scenario = try await spec.setup(transport)
    defer { scenario.dispose() }
    guard !scenario.outputs.isEmpty || !scenario.settlements.isEmpty else {
      throw AxiomViolation("A liveness scenario must observe an output or a settlement")
    }
    let delays = schedule.reduce(Duration.zero) { total, fault in
      if case .delay(let delay) = fault { return total + delay }
      return total
    }
    let bound = (spec.timeout * (spec.retryBudget + 1) + delays) * 4
    let (observations, observation) = AsyncStream<Observation>.makeStream()
    var tasks: [Task<Void, Never>] = []
    for (index, output) in scenario.outputs.enumerated() {
      tasks.append(
        Task {
          await output()
          observation.yield(.output(index))
        })
    }
    for (index, settlement) in scenario.settlements.enumerated() {
      tasks.append(
        Task {
          await settlement()
          observation.yield(.settlement(index))
        })
    }
    tasks.append(
      Task {
        do {
          try await Task.sleep(for: bound)
          observation.yield(.deadline)
        } catch {}
      })
    defer {
      observation.finish()
      for task in tasks { task.cancel() }
    }
    var outcomes: Set<Observation> = []
    let count = scenario.outputs.count + scenario.settlements.count
    for await next in observations {
      if next == .deadline { break }
      outcomes.insert(next)
      if outcomes.count == count { break }
    }
    try Task.checkCancellation()
    if let index = scenario.settlements.indices.first(where: { !outcomes.contains(.settlement($0)) }
    ) {
      throw AxiomViolation("L2: settlement \(index) timed out under \(schedule)")
    }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    let attempts = try Dictionary(grouping: transport.attempts) { attempt in
      RequestKey(operation: attempt.operation, payload: try encoder.encode(attempt.payload))
    }
    if let exceeded = attempts.first(where: { $0.value.count > spec.retryBudget + 1 }) {
      throw AxiomViolation(
        "L2: \(exceeded.key.operation) exceeded its retry budget under \(schedule)")
    }
    if let index = scenario.outputs.indices.first(where: { !outcomes.contains(.output($0)) }) {
      throw AxiomViolation("L1: output \(index) stayed silent under \(schedule)")
    }
  }
}

private enum Observation: Hashable, Sendable {
  case output(Int)
  case settlement(Int)
  case deadline
}

private struct RequestKey: Hashable {
  let operation: String
  let payload: Data
}

public protocol DeliverySubject: Sendable {
  func write(_ eventId: String) async throws
  func transition() async throws
  func delivered() async throws -> [String]
}

public enum DeliveryOp: String, Sendable, CaseIterable {
  case write, transition
}

public func deliveryOps(_ count: Int, longest: Int) -> [[DeliveryOp]] {
  precondition(count >= 0 && longest > 0)
  var random = ScheduleRandom()
  return (0..<count).map { _ in
    var operations: [DeliveryOp] = (0..<Int.random(in: 1...longest, using: &random)).map { _ in
      Bool.random(using: &random) ? .write : .transition
    }
    if !operations.contains(.write) { operations[0] = .write }
    return operations
  }
}

public func assertExactlyOnceDelivery(
  _ interleavings: [[DeliveryOp]], setup: @Sendable () async throws -> any DeliverySubject
) async throws {
  guard !interleavings.isEmpty else {
    throw AxiomViolation("Delivery needs at least one interleaving")
  }
  for operations in interleavings {
    let subject = try await setup()
    var written: [String] = []
    for (index, operation) in operations.enumerated() {
      switch operation {
      case .write:
        let id = "e\(index)"
        try await subject.write(id)
        written.append(id)
      case .transition:
        try await subject.transition()
      }
    }
    let delivered = try await subject.delivered()
    guard !written.isEmpty, delivered == written else {
      throw AxiomViolation("L3: wrote \(written) and received \(delivered) under \(operations)")
    }
  }
}

private struct ScheduleRandom: RandomNumberGenerator {
  private var state: UInt64 = 7

  mutating func next() -> UInt64 {
    state &+= 0x9e37_79b9_7f4a_7c15
    var mixed = state
    mixed = (mixed ^ (mixed >> 30)) &* 0xbf58_476d_1ce4_e5b9
    mixed = (mixed ^ (mixed >> 27)) &* 0x94d0_49bb_1331_11eb
    return mixed ^ (mixed >> 31)
  }
}
