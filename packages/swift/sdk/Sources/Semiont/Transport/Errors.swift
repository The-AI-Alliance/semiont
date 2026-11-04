import Foundation

public struct TransportError: Error, Sendable, CustomStringConvertible {
  public let reason: TransportErrorCode
  public let status: Int?
  public let description: String
  public let retryAfterMs: Int?
  public var code: String { reason.rawValue }
  init(
    _ reason: TransportErrorCode, _ message: String, status: Int? = nil, retryAfterMs: Int? = nil
  ) {
    self.reason = reason
    self.description = message
    self.status = status
    self.retryAfterMs = retryAfterMs
  }
}
public struct BusRequestError: Error, Sendable, CustomStringConvertible {
  public let reason: BusRequestErrorCode
  public let description: String
  public var code: String { reason.rawValue }
  package init(_ reason: BusRequestErrorCode, _ message: String) {
    self.reason = reason
    self.description = message
  }
}
public enum ConnectionState: String, Sendable, CaseIterable {
  case initial, connecting, open, reconnecting, degraded, unauthenticated, closed
  func mayBecome(_ next: Self) -> Bool {
    switch self {
    case .initial: [.connecting, .unauthenticated, .closed].contains(next)
    case .connecting: [.open, .reconnecting, .unauthenticated, .closed].contains(next)
    case .open: [.reconnecting, .closed].contains(next)
    case .reconnecting: [.connecting, .degraded, .unauthenticated, .closed].contains(next)
    case .degraded: [.connecting, .unauthenticated, .closed].contains(next)
    case .unauthenticated: [.connecting, .closed].contains(next)
    case .closed: false
    }
  }
}

enum RetryContext: String, CaseIterable {
  case boot, transport, refresh, job
  func retryable(status: Int?, method: String?) -> Bool {
    switch self {
    case .boot: status.map { [429, 503, 504].contains($0) } == true
    case .transport:
      status.map { [408, 413, 429, 500, 502, 503, 504].contains($0) } == true
        && method.map {
          ["GET", "HEAD", "PUT", "DELETE", "OPTIONS", "TRACE"].contains($0.uppercased())
        } == true
    case .refresh: status.map { $0 == 408 || $0 == 429 || $0 >= 500 } ?? true
    case .job: status.map { [408, 429, 500, 503].contains($0) } == true
    }
  }
}
func retryAfterMs(_ header: String?) -> Int? {
  guard let text = header?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty,
    text.utf8.allSatisfy({ (48...57).contains($0) }), let seconds = Int(text),
    seconds <= Int.max / 1000
  else { return nil }
  return seconds * 1000
}
func equalJitter(_ cap: Int) -> Int { Int.random(in: (max(0, cap) / 2)...max(0, cap)) }
func sleepMilliseconds(_ milliseconds: Int) async throws {
  try Task.checkCancellation()
  if milliseconds > 0 { try await Task.sleep(nanoseconds: UInt64(milliseconds) * 1_000_000) }
}

public struct TransportTiming: Sendable {
  public var busRequestTimeoutMs: Int
  public var reconnectMs: Int
  public var lazyRemoveMs: Int
  public var lingerMs: Int
  public var seenEventIdsCount: Int
  public var httpRequestMs: Int
  public var streamOpenMs: Int
  public var emitAttempts: Int
  public var emitInitialDelayMs: Int
  public var emitMaxDelayMs: Int
  public init(
    reconnectMs: Int? = nil, lazyRemoveMs: Int? = nil, lingerMs: Int? = nil,
    seenEventIdsCount: Int? = nil, httpRequestMs: Int? = nil, streamOpenMs: Int? = nil,
    emitAttempts: Int? = nil, emitInitialDelayMs: Int? = nil, emitMaxDelayMs: Int? = nil,
    busRequestTimeoutMs: Int? = nil
  ) {
    self.busRequestTimeoutMs = busRequestTimeoutMs ?? Timings.busRequestTimeoutMs
    self.reconnectMs = reconnectMs ?? Timings.reconnectMs
    self.lazyRemoveMs = lazyRemoveMs ?? Timings.lazyRemoveMs
    self.lingerMs = lingerMs ?? Timings.lingerMs
    self.seenEventIdsCount = seenEventIdsCount ?? Timings.seenEventIdsCount
    self.httpRequestMs = httpRequestMs ?? Timings.httpRequestTimeoutMs
    self.streamOpenMs = streamOpenMs ?? Timings.streamOpenTimeoutMs
    self.emitAttempts = emitAttempts ?? Timings.emitRetry.attempts
    self.emitInitialDelayMs = emitInitialDelayMs ?? Timings.emitRetry.initialDelayMs
    self.emitMaxDelayMs = emitMaxDelayMs ?? Timings.emitRetry.maxDelayMs
  }
}
