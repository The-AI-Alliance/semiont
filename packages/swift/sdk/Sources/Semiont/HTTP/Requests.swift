import Foundation

struct WireOperation: Sendable {
  let result: String
  let resultStamps: Set<String>
  let failure: String
  let failureStamps: Set<String>
  let request: @Sendable ([String: JSONValue]) throws -> [String: JSONValue]
  let response: @Sendable ([String: JSONValue]) throws -> [String: JSONValue]
}
func projectWire<Value: Codable>(
  _ type: Value.Type, _ payload: [String: JSONValue], stamps: Set<String>
) throws
  -> [String: JSONValue]
{
  let data = try JSONEncoder().encode(declared(payload, stamps: stamps))
  let decoded = try JSONDecoder().decode(type, from: data)
  return try JSONDecoder().decode([String: JSONValue].self, from: JSONEncoder().encode(decoded))
}
/// What a request answered on `channel`, its operation's failure channel, fails with. A failure is
/// held to its channel's shape before it is read, as a result is: one with a fault is refused,
/// naming the fault. One the shape passes is read as the shape reads it, a code it does not
/// recognize left out, and is a `BusRequestError` in its own words, under the code its own code
/// becomes, or, when it states none, the code of a failure that states none.
func projectFailure(_ payload: [String: JSONValue], on channel: String, stamps: Set<String>)
  -> any Error
{
  let failure: [String: JSONValue]
  do throws(Fault) {
    failure = try payloadAsRead(declared(payload, stamps: stamps), on: channel)
  } catch {
    return TransportError(.error, notTheChannels(channel, error))
  }
  guard case .string(let message) = failure["message"] else {
    return TransportError(.error, notTheChannels(channel, .undecoded))
  }
  let code: BusRequestErrorCode =
    switch failureCode(failure["code"]) {
    case nil: unrecognizedBusFailure
    case let wire?: busRequestCode(for: wire)
    }
  return BusRequestError(code, message)
}
/// The code a failure the table passed states, as the closed type: none when it states none, or
/// null, which is no code.
private func failureCode(_ held: JSONValue?) -> CommandErrorCode? {
  guard let held, held != .null else { return nil }
  guard case .string(let text) = held, let code = CommandErrorCode(rawValue: text) else {
    preconditionFailure("the table passed the code \(held), which CommandErrorCode does not name")
  }
  return code
}
extension HttpTransport {
  public func request(operation: String, payload: [String: JSONValue]) async throws
    -> [String: JSONValue]
  {
    try await requestFrame(operation: operation, payload: payload).payload
  }

  func requestFrame(
    operation: String, payload: [String: JSONValue], parent: [String: String]? = nil,
    enqueued: (@Sendable () -> Void)? = nil
  ) async throws -> ReceivedFrame {
    guard let descriptor = wireOperations[operation] else {
      throw BusRequestError(.busRejected, "Unknown operation \(operation)")
    }
    for channel in [descriptor.result, descriptor.failure] where !channels.contains(channel) {
      throw unsubscribed(channel)
    }
    try Task.checkCancellation()
    if lifetime.ended { throw BusRequestError(.busClosed, "The transport closed") }
    let body = try descriptor.request(payload)
    let correlation = UUID().uuidString
    let senderID = UUID()
    let life = lifetime
    let frame: ReceivedFrame = try await withTaskCancellationHandler {
      try await withCheckedThrowingContinuation { continuation in
        pending[correlation] = Pending(
          result: descriptor.result, failure: descriptor.failure,
          cancel: { life.cancel(senderID) }, complete: { continuation.resume(with: $0) })
        let emission = enqueueEmission(
          channel: operation, payload: body, correlationId: correlation, afterOpen: true,
          parent: parent)
        enqueued?()
        let send = spawn(on: self) { transport in
          defer { life.forget(senderID) }
          do {
            let count = try await transport.awaitEmission(emission)
            if count == 0 {
              transport.fail(
                correlation,
                error: BusRequestError(.busPeerUnavailable, "No peer answers \(operation)"))
            }
          } catch { transport.fail(correlation, error: error) }
        }
        life.keep(send, id: senderID)
      }
    } onCancel: {
      spawn(on: self) { transport in transport.fail(correlation, error: CancellationError()) }
    }
    if frame.channel == descriptor.failure {
      throw projectFailure(frame.payload, on: descriptor.failure, stamps: descriptor.failureStamps)
    }
    let read: [String: JSONValue]
    do throws(Fault) {
      read = try payloadAsRead(
        declared(frame.payload, stamps: descriptor.resultStamps), on: descriptor.result)
    } catch {
      throw TransportError(.error, notTheChannels(descriptor.result, error))
    }
    do {
      var answer = frame
      answer.payload = try descriptor.response(read)
      return answer
    } catch {
      throw TransportError(.error, notTheChannels(descriptor.result, .undecoded))
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
