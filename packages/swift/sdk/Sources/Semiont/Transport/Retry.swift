/// Retries a refused operation with capped exponential backoff and equal jitter.
public func retryWithBackoff<Value: Sendable>(
  attempts: Int, initialDelayMs: Int, maxDelayMs: Int,
  retryable: @Sendable (any Error) -> Bool,
  retryAfterMs: @Sendable (any Error) -> Int? = { _ in nil },
  operation: @Sendable (Int) async throws -> Value
) async throws -> Value {
  precondition(attempts > 0 && initialDelayMs >= 0 && maxDelayMs >= initialDelayMs)
  var delay = initialDelayMs
  for attempt in 1...attempts {
    try Task.checkCancellation()
    do {
      return try await operation(attempt)
    } catch {
      if Task.isCancelled || error is CancellationError { throw CancellationError() }
      guard attempt < attempts, retryable(error) else { throw error }
      try await sleepMilliseconds(max(equalJitter(delay), retryAfterMs(error) ?? 0))
      delay = delay > maxDelayMs / 2 ? maxDelayMs : delay * 2
    }
  }
  preconditionFailure("A retry budget contains at least one attempt")
}
