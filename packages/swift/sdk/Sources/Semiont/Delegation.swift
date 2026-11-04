import Foundation

public enum JobEvent<Completion: Sendable>: Sendable {
  case created(JobCreatedResultResponse)
  case progress(JobProgress)
  case failed(JobFailCommand)
  case complete(Completion)
}
public final class Delegation<Completion: Sendable>: AsyncSequence, Sendable {
  public typealias Element = JobEvent<Completion>
  public typealias AsyncIterator = Running<Element>.AsyncIterator
  private let following: Running<Element>
  init(_ following: Running<Element>) { self.following = following }
  public func makeAsyncIterator() -> AsyncIterator { following.makeAsyncIterator() }
  public func completed() async throws -> Completion {
    guard case .complete(let value) = try await following.completed() else {
      throw TransportError(.error, "A delegated job ended without its completion")
    }
    return value
  }
  public func dispose() { following.dispose() }
}
public struct JobError: Error, Sendable, CustomStringConvertible {
  public let reason: JobErrorCode
  public let description: String
  public let jobId: JobId?
  public let failureClass: FailureClass?
  public var code: String { reason.rawValue }
}
public struct FollowTiming: Sendable {
  public let silenceMs: Int
  public let statusPollMs: Int
  let clock: any Clock<Duration>
  public init(silenceMs: Int? = nil, statusPollMs: Int? = nil) {
    self.init(silenceMs: silenceMs, statusPollMs: statusPollMs, clock: ContinuousClock())
  }

  package init(
    silenceMs: Int? = nil, statusPollMs: Int? = nil, clock: any Clock<Duration>
  ) {
    self.clock = clock
    self.silenceMs = silenceMs ?? Timings.jobSilenceMs
    self.statusPollMs = statusPollMs ?? Timings.jobStatusPollMs
  }
}
protocol FollowedCompletion: Codable, Sendable {
  static func matching(_ completion: JobCompleteCommand) throws -> Self
  static func learned(_ status: JobStatusResponse, resource: ResourceId) throws -> Self
}
private func wrongCompletion() -> TransportError {
  TransportError(.error, "The job's completion is not the delegated verb's")
}
extension MarkJobCompleteCommand: FollowedCompletion {
  static func matching(_ completion: JobCompleteCommand) throws -> Self {
    switch completion {
    case .markJobCompleteCommand(let value): return value
    case .yieldJobCompleteCommand: throw wrongCompletion()
    }
  }
  static func learned(_ status: JobStatusResponse, resource: ResourceId) throws -> Self {
    guard status.type == .mark else { throw wrongCompletion() }
    let result: MarkJobResult?
    switch status.result {
    case nil, .empty: result = nil
    case .jobResult(.markJobDone(let value)): result = .markJobDone(value)
    case .jobResult(.jobDeclined(let value)): result = .jobDeclined(value)
    case .jobResult(.yieldJobDone): throw wrongCompletion()
    }
    return Self(jobId: status.jobId, resourceId: resource, result: result)
  }
}
extension YieldJobCompleteCommand: FollowedCompletion {
  static func matching(_ completion: JobCompleteCommand) throws -> Self {
    switch completion {
    case .yieldJobCompleteCommand(let value): return value
    case .markJobCompleteCommand: throw wrongCompletion()
    }
  }
  static func learned(_ status: JobStatusResponse, resource: ResourceId) throws -> Self {
    guard status.type == .yield else { throw wrongCompletion() }
    let result: YieldJobResult?
    switch status.result {
    case nil, .empty: result = nil
    case .jobResult(.yieldJobDone(let value)): result = .yieldJobDone(value)
    case .jobResult(.jobDeclined(let value)): result = .jobDeclined(value)
    case .jobResult(.markJobDone): throw wrongCompletion()
    }
    return Self(jobId: status.jobId, resourceId: resource, result: result)
  }
}
