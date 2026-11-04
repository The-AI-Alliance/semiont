import Foundation

public struct Bus: Sendable {
  private let transport: any Transport
  public init(_ transport: any Transport) { self.transport = transport }
  public func emit<Payload>(
    _ channel: Channel<Payload>, _ payload: Payload, scope: ResourceId? = nil,
    correlationId: String? = nil
  ) async throws -> Int? {
    try await transport.emit(
      channel: channel.name, payload: wirePayload(payload), scope: scope,
      correlationId: correlationId)
  }
  public func frames<Payload>(_ channel: Channel<Payload>) async throws -> Typed<Payload> {
    let source = try await transport.frames([channel.name])
    do { try Task.checkCancellation() } catch {
      source.dispose()
      throw error
    }
    return Typed(channel: channel.name, stamps: channel.stamps, source: source)
  }
  public func frames<Payload>(_ channel: ScopedChannel<Payload>, resource: ResourceId) async throws
    -> Typed<Payload>
  {
    let source = try await transport.frames([channel.name])
    let hold = await transport.subscribeToResource(resource)
    do { try Task.checkCancellation() } catch {
      source.dispose()
      hold.dispose()
      throw error
    }
    return Typed(
      channel: channel.name, stamps: channel.stamps, source: source, resource: resource, hold: hold)
  }
  public func request<Request, Result, Failure>(
    _ operation: Operation<Request, Result, Failure>, _ payload: Request, timeoutMs: Int? = nil
  ) async throws -> Result {
    try await request(operation, payload, timeoutMs: timeoutMs, enqueued: nil)
  }

  func request<Request, Result, Failure>(
    _ operation: Operation<Request, Result, Failure>, _ payload: Request, timeoutMs: Int? = nil,
    enqueued: (@Sendable () -> Void)?
  ) async throws -> Result {
    let body = try wirePayload(payload)
    let response: [String: JSONValue]
    if let enqueued, let http = transport as? HttpTransport {
      response = try await http.request(
        operation: operation.request.name, payload: body, timeoutMs: timeoutMs, enqueued: enqueued)
    } else {
      response = try await transport.request(
        operation: operation.request.name, payload: body, timeoutMs: timeoutMs)
      enqueued?()
    }
    do {
      return try JSONDecoder().decode(
        Result.self, from: JSONEncoder().encode(declared(response, stamps: operation.result.stamps))
      )
    } catch {
      let lacks = requiredPayloadMembers[operation.result.name]?.lacking(in: .object(response))
      let detail = lacks.map { ": it has no `\($0)`" } ?? ""
      throw TransportError(
        .error, "A payload on \(operation.result.name) is not that channel's\(detail)")
    }
  }
}
