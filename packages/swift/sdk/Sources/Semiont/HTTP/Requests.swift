import Foundation

struct WireOperation: Sendable {
  let result: String
  let failure: String
  let request: @Sendable ([String: JSONValue]) throws -> [String: JSONValue]
  let response: @Sendable ([String: JSONValue]) throws -> [String: JSONValue]
}
func projectWire<Value: Codable>(_ type: Value.Type, _ payload: [String: JSONValue]) throws
  -> [String: JSONValue]
{
  let data = try JSONEncoder().encode(payload)
  let decoded = try JSONDecoder().decode(type, from: data)
  return try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(decoded))
}
extension HttpTransport {
  public func request(operation: String, payload: [String: JSONValue], timeoutMs: Int? = nil)
    async throws -> [String: JSONValue]
  {
    guard let descriptor = wireOperations[operation] else {
      throw BusRequestError(.busRejected, "Unknown operation \(operation)")
    }
    for channel in [descriptor.result, descriptor.failure] where !channels.contains(channel) {
      throw BusRequestError(.busUnsubscribed, "Transport is not subscribed to \(channel)")
    }
    try Task.checkCancellation()
    if lifetime.ended { throw BusRequestError(.busClosed, "The transport closed") }
    let body = try descriptor.request(payload)
    let correlation = UUID().uuidString
    let senderID = UUID()
    let timerID = UUID()
    let life = lifetime
    let frame: ReceivedFrame = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending[correlation] = Pending(
          result: descriptor.result, failure: descriptor.failure,
          cancel: {
            life.cancel(senderID)
            life.cancel(timerID)
          }, complete: { continuation.resume(with: $0) })
        let emission = enqueueEmission(
          channel: operation, payload: body, correlationId: correlation, afterOpen: true)
        let send = Task { [self] in
          defer { life.forget(senderID) }
          do {
            let count = try await awaitEmission(emission)
            if count == 0 {
              fail(
                correlation,
                error: BusRequestError(.busPeerUnavailable, "No peer answers \(operation)"))
            }
          } catch { fail(correlation, error: error) }
        }
        life.keep(send, id: senderID)
        let timer = Task { [weak self] in
          defer { life.forget(timerID) }
          do { try await sleepMilliseconds(timeoutMs ?? Timings.busRequestTimeoutMs) } catch {
            return
          }
          await self?.fail(
            correlation, error: BusRequestError(.busTimeout, "\(operation) timed out"))
        }
        life.keep(timer, id: timerID)
      }
    } onCancel: {
      Task { await self.fail(correlation, error: CancellationError()) }
    }
    if frame.channel == descriptor.failure {
      let failure: CommandError
      do {
        failure = try JSONDecoder().decode(
          CommandError.self, from: JSONEncoder().encode(frame.payload))
      } catch {
        throw BusRequestError(
          unrecognizedBusFailure, "Malformed failure for \(operation): \(error)")
      }
      let code =
        failure.code.flatMap { busRequestCodeByWireCode[$0.rawValue] } ?? unrecognizedBusFailure
      throw BusRequestError(code, failure.message)
    }
    do { return try descriptor.response(frame.payload) } catch {
      throw BusRequestError(.busRejected, "Malformed reply for \(operation): \(error)")
    }
  }
  func fail(_ correlation: String, error: any Error) {
    guard let waiting = pending.removeValue(forKey: correlation) else { return }
    waiting.cancel()
    waiting.complete(.failure(error))
  }
  func waitUntilOpen() async throws {
    for await value in state {
      try Task.checkCancellation()
      if value == .open { return }
      if value == .closed { throw BusRequestError(.busClosed, "The transport closed") }
    }
    try Task.checkCancellation()
    throw BusRequestError(.busClosed, "The transport closed")
  }
}
