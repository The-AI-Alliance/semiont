import AsyncHTTPClient
import Foundation
import OpenTelemetryApi

private struct RequestDeadline: Error {}
func within<Value: Sendable>(
  _ milliseconds: Int, operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
  try await withThrowingTaskGroup(of: Value.self) { group in
    group.addTask { try await operation() }
    group.addTask {
      try await sleepMilliseconds(milliseconds)
      throw RequestDeadline()
    }
    defer { group.cancelAll() }
    guard let value = try await group.next() else { throw CancellationError() }
    return value
  }
}

func within<Value: Sendable>(
  until deadline: ContinuousClock.Instant, operation: @escaping @Sendable () async throws -> Value
) async throws -> Value {
  try await withThrowingTaskGroup(of: Value.self) { group in
    group.addTask { try await operation() }
    group.addTask {
      try await ContinuousClock().sleep(until: deadline)
      throw RequestDeadline()
    }
    defer { group.cancelAll() }
    guard let value = try await group.next() else { throw CancellationError() }
    return value
  }
}

extension HttpTransport {
  func owned<Value: Sendable>(
    _ operation: @escaping @Sendable (isolated HttpTransport) async throws -> Value
  ) async throws -> Value {
    let id = UUID()
    let task = Task { try await operation(self) }
    lifetime.keep(task, id: id)
    defer { lifetime.forget(id) }
    return try await withTaskCancellationHandler {
      try await task.value
    } onCancel: {
      task.cancel()
    }
  }
  struct Exchange: Sendable {
    let response: HTTPClientResponse
    let deadline: ContinuousClock.Instant
  }
  static func refusal(_ response: HTTPClientResponse, path: String, deadlineMs: Int) async
    -> TransportError
  {
    let data = try? await within(deadlineMs) {
      var data = Data()
      for try await chunk in response.body { data.append(contentsOf: chunk.readableBytesView) }
      return data
    }
    let body = data.flatMap { try? JSONDecoder().decode(ErrorResponse.self, from: $0) }
    let status = Int(response.status.code)
    let code: TransportErrorCode =
      status == 429 && body?.code == "refusal-rate"
      ? .unauthorized : transportErrorCode(for: status)
    let message = path + " \(status)" + (body.map { ": " + $0.error } ?? "")
    return TransportError(
      code, message, status: status,
      retryAfterMs: retryAfterMs(response.headers.first(name: "Retry-After")))
  }
  func begin(
    method: String, path: String, body: Data? = nil, contentType: String? = nil,
    authenticated: Bool = true, trace: [String: String]? = nil
  ) async throws -> Exchange {
    var credential = authenticated ? token : nil
    var renewed = false
    var retried = false
    while true {
      try Task.checkCancellation()
      if lifetime.ended { throw CancellationError() }
      let deadline = ContinuousClock.now.advanced(by: .milliseconds(timing.httpRequestMs))
      var request = HTTPClientRequest(url: baseUrl + path)
      request.method = .RAW(value: method)
      let propagation =
        trace ?? OpenTelemetry.instance.contextProvider.activeSpan.map(traceCarrier) ?? [:]
      for (key, value) in propagation { request.headers.add(name: key, value: value) }
      if let credential {
        request.headers.add(name: "Authorization", value: "Bearer " + credential)
      }
      if let contentType { request.headers.add(name: "Content-Type", value: contentType) }
      if let body { request.body = .bytes(body) }
      do {
        let http = self.http
        let response = try await within(timing.httpRequestMs) { [request] in
          try await http.execute(request, deadline: .distantFuture)
        }
        if (200..<300).contains(Int(response.status.code)) {
          return Exchange(response: response, deadline: deadline)
        }
        let error = await Self.refusal(response, path: path, deadlineMs: timing.httpRequestMs)
        if error.reason == .unauthorized {
          if authenticated, !renewed {
            renewed = true
            if let replacement = try await renew(refused: credential) {
              credential = replacement
              continue
            }
          }
        } else if !retried, RetryContext.transport.retryable(status: error.status, method: method) {
          retried = true
          try await sleepMilliseconds(max(Timings.requestRetryPauseMs, error.retryAfterMs ?? 0))
          continue
        }
        throw error
      } catch is CancellationError { throw CancellationError() } catch let error as TransportError {
        failureEvents.yield(error)
        throw error
      } catch {
        if Task.isCancelled || lifetime.ended { throw CancellationError() }
        if !(error is RequestDeadline), !retried,
          RetryContext.transport.retryable(status: 503, method: method)
        {
          retried = true
          try await sleepMilliseconds(Timings.requestRetryPauseMs)
          continue
        }
        let failure = TransportError(.unavailable, "\(method) \(path) got no answer: \(error)")
        failureEvents.yield(failure)
        throw failure
      }
    }
  }
  func answer<Value: Decodable & Sendable>(
    _ type: Value.Type, method: String = "GET", path: String,
    body: Data? = nil, contentType: String? = nil, authenticated: Bool = true,
    trace: [String: String]? = nil
  ) async throws -> Value {
    try await owned { owner in
      try await owner.decodeAnswer(
        type, method: method, path: path, body: body, contentType: contentType,
        authenticated: authenticated, trace: trace)
    }
  }
  private func decodeAnswer<Value: Decodable & Sendable>(
    _ type: Value.Type, method: String, path: String,
    body: Data?, contentType: String?, authenticated: Bool, trace: [String: String]?
  ) async throws -> Value {
    let exchange = try await begin(
      method: method, path: path, body: body, contentType: contentType,
      authenticated: authenticated, trace: trace)
    let response = exchange.response
    do {
      let read: @Sendable () async throws -> Data = {
        var data = Data()
        for try await chunk in response.body { data.append(contentsOf: chunk.readableBytesView) }
        return data
      }
      let data = try await within(until: exchange.deadline, operation: read)
      return try JSONDecoder().decode(type, from: data)
    } catch {
      if Task.isCancelled || lifetime.ended { throw CancellationError() }
      let failure = TransportError(
        error is RequestDeadline ? .unavailable : .error,
        "\(method) \(path) answered invalid \(type): \(error)")
      failureEvents.yield(failure)
      throw failure
    }
  }
  public func getCurrentUser() async throws -> UserResponse {
    try await answer(UserResponse.self, path: "/api/users/me")
  }
  public func getStatus() async throws -> StatusResponse {
    try await answer(StatusResponse.self, path: "/api/status")
  }
  public func healthCheck() async throws -> HealthResponse {
    try await answer(HealthResponse.self, path: "/api/health")
  }
  public func getProtectedResourceMetadata() async throws -> ProtectedResourceMetadata {
    try await answer(
      ProtectedResourceMetadata.self, path: "/.well-known/oauth-protected-resource",
      authenticated: false)
  }
  public func getMediaToken(_ resource: ResourceId) async throws -> MediaTokenResponse {
    try await answer(
      MediaTokenResponse.self, method: "POST", path: "/api/tokens/media",
      body: JSONEncoder().encode(MediaTokenRequest(resourceId: resource)),
      contentType: "application/json")
  }

  public func emit(
    channel: String, payload: [String: JSONValue], scope: ResourceId? = nil,
    correlationId: String? = nil
  ) async throws -> Int? {
    try await awaitEmission(
      enqueueEmission(
        channel: channel, payload: payload, scope: scope, correlationId: correlationId))
  }
  func enqueueEmission(
    channel: String, payload: [String: JSONValue], scope: ResourceId? = nil,
    correlationId: String?, afterOpen: Bool = false
  ) -> Task<Int?, any Error> {
    let previous = emitTail
    let id = UUID()
    let life = lifetime
    let task = Task { [self] in
      defer { life.forget(id) }
      if let previous { await previous.value }
      try Task.checkCancellation()
      if afterOpen { try await waitUntilOpen() }
      return try await send(
        channel: channel, payload: payload, scope: scope, correlationId: correlationId)
    }
    emitTail = Task { _ = try? await task.value }
    life.keep(task, id: id)
    return task
  }
  func awaitEmission(_ task: Task<Int?, any Error>) async throws -> Int? {
    try await withTaskCancellationHandler {
      try await sharedValue(task, lifetime: lifetime)
    } onCancel: {
      task.cancel()
    }
  }
  func send(
    channel: String, payload: [String: JSONValue], scope: ResourceId?, correlationId: String?
  ) async throws -> Int? {
    let emission = transportSpan(.busEmitChannel, channel: channel, scope: scope)
    defer { emission.end() }
    sent(channel: channel, scope: scope)
    let trace = traceCarrier(emission)
    BusLog.line(
      "EMIT", channel: channel, payload: payload, scope: scope, correlationID: correlationId,
      traceID: emission.context.traceId.hexString)
    let body = try JSONEncoder().encode(
      BusEmitRequest(
        channel: channel, clientId: clientID, correlationId: correlationId, payload: payload,
        scope: scope))
    var credential = token
    var renewed = false
    var attempts = 1
    var cap = timing.emitInitialDelayMs
    while true {
      try Task.checkCancellation()
      if lifetime.ended { throw CancellationError() }
      var request = HTTPClientRequest(url: baseUrl + "/bus/emit")
      request.method = .POST
      request.headers.add(name: "Content-Type", value: "application/json")
      if let credential {
        request.headers.add(name: "Authorization", value: "Bearer " + credential)
      }
      for (key, value) in trace { request.headers.add(name: key, value: value) }
      request.body = .bytes(body)
      let failure: TransportError
      do {
        let http = self.http
        let accepted = try await within(Timings.emitTimeoutMs) { [request] in
          let response = try await http.execute(request, deadline: .distantFuture)
          if !(200..<300).contains(Int(response.status.code)) {
            throw await Self.refusal(
              response, path: "/bus/emit", deadlineMs: self.timing.httpRequestMs)
          }
          var data = Data()
          for try await chunk in response.body { data.append(contentsOf: chunk.readableBytesView) }
          return try JSONDecoder().decode(BusEmitAccepted.self, from: data)
        }
        return accepted.subscribers
      } catch let error as TransportError { failure = error } catch {
        if Task.isCancelled || lifetime.ended { throw CancellationError() }
        failure = TransportError(.unavailable, "/bus/emit got no answer: \(error)")
      }
      if failure.reason == .unauthorized {
        if !renewed {
          renewed = true
          if let replacement = try await renew(refused: credential) {
            credential = replacement
            continue
          }
        }
        failureEvents.yield(failure)
        throw failure
      }
      if attempts >= timing.emitAttempts
        || (failure.status != nil
          && !RetryContext.boot.retryable(status: failure.status, method: "POST"))
      {
        failureEvents.yield(failure)
        throw failure
      }
      try await sleepMilliseconds(max(equalJitter(cap), failure.retryAfterMs ?? 0))
      cap = min(cap * 2, timing.emitMaxDelayMs)
      attempts += 1
    }
  }
}
