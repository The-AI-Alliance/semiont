import AsyncHTTPClient
import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import OpenTelemetryApi
import OpenTelemetrySdk
import Synchronization
import Testing

@testable import Semiont

private enum Answer: Sendable { case noHeaders, noBody, refusalWithoutBody, idleStream }
private final class Endpoint: ChannelInboundHandler {
  typealias InboundIn = HTTPServerRequestPart
  typealias OutboundOut = HTTPServerResponsePart
  let answer: Answer
  init(_ answer: Answer) { self.answer = answer }
  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    guard case .end = unwrapInboundIn(data), answer != .noHeaders else { return }
    let status: HTTPResponseStatus = answer == .refusalWithoutBody ? .unauthorized : .ok
    let type = answer == .idleStream ? "text/event-stream" : "application/json"
    let headers = HTTPHeaders([("Content-Type", type), ("Content-Length", "1000")])
    context.writeAndFlush(
      wrapOutboundOut(.head(HTTPResponseHead(version: .http1_1, status: status, headers: headers))),
      promise: nil)
  }
}
private func server<Value: Sendable>(
  _ answer: Answer, _ run: @Sendable (String, HTTPClient) async throws -> Value
) async throws -> Value {
  let channel = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
    .childChannelInitializer { channel in
      channel.eventLoop.makeCompletedFuture {
        try channel.pipeline.syncOperations.configureHTTPServerPipeline()
        try channel.pipeline.syncOperations.addHandler(Endpoint(answer))
      }
    }.bind(host: "127.0.0.1", port: 0).get()
  let port = try #require(channel.localAddress?.port)
  let http = HTTPClient(eventLoopGroupProvider: .singleton)
  do {
    let result = try await run("http://127.0.0.1:\(port)", http)
    try await http.shutdown()
    try await channel.close().get()
    return result
  } catch {
    try? await http.shutdown()
    try? await channel.close().get()
    throw error
  }
}
@Test func streamOpeningDeadlineBoundsHeadersAndNotAnIdleOpenStream() async throws {
  try await server(.noHeaders) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: ["beckon:focus"],
      timing: TransportTiming(reconnectMs: 500, streamOpenMs: 20))
    defer { transport.dispose() }
    let state = try await within(1000) {
      for await state in transport.state where state == .reconnecting { return state }
      throw CancellationError()
    }
    #expect(state == .reconnecting)
  }
  try await server(.idleStream) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: ["beckon:focus"],
      timing: TransportTiming(streamOpenMs: 20))
    defer { transport.dispose() }
    try await within(1000) { try await transport.waitUntilOpen() }
    try await sleepMilliseconds(80)
    #expect(transport.state.value == .open)
  }
}
@Test func refusalBodyDeadlinePreservesTheStatus() async throws {
  try await server(.refusalWithoutBody) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: [],
      timing: TransportTiming(httpRequestMs: 20))
    defer { transport.dispose() }
    do {
      _ = try await within(1000) { try await transport.getCurrentUser() }
      Issue.record("A 401 succeeded")
    } catch let failure as TransportError {
      #expect(failure.status == 401)
      #expect(failure.reason == .unauthorized)
    }
  }
}
@Test func aReadDeadlineIncludesTheBody() async throws {
  try await server(.noBody) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: [],
      timing: TransportTiming(httpRequestMs: 20))
    defer { transport.dispose() }
    do {
      _ = try await within(1000) { try await transport.getBinary(ResourceId("resource")) }
      Issue.record("An unfinished read succeeded")
    } catch let failure as TransportError { #expect(failure.reason == .unavailable) }
  }
}
@Test func disposalCancelsInFlightGatewayOperations() async throws {
  try await server(.noHeaders) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: [],
      timing: TransportTiming(httpRequestMs: 5000))
    let request = Task { try await transport.getCurrentUser() }
    try await sleepMilliseconds(20)
    transport.dispose()
    do {
      _ = try await within(1000) { try await request.value }
      Issue.record("A disposed request succeeded")
    } catch is CancellationError {}
  }
}

private actor RenewalGate {
  let started = Watched(0)
  private var continuation: CheckedContinuation<String?, Never>?
  func renew() async -> String? {
    started.set(started.value + 1)
    return await withCheckedContinuation { continuation = $0 }
  }
  func release() {
    continuation?.resume(returning: "new-token")
    continuation = nil
  }
}
@Test func cancellationLeavesASharedRenewalForOtherCallers() async throws {
  try await server(.noHeaders) { base, http in
    let gate = RenewalGate()
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "old-token", channels: [],
      refresher: { _ in await gate.renew() })
    defer { transport.dispose() }
    let completed = Watched<Result<String?, any Error>?>(nil)
    let first = Task {
      do { completed.set(.success(try await transport.renew(refused: "old-token"))) } catch {
        completed.set(.failure(error))
      }
    }
    try await within(1000) { for await count in gate.started where count == 1 { return } }
    let second = Task { try await transport.renew(refused: "old-token") }
    first.cancel()
    do {
      let result = try await within(1000) {
        for await result in completed { if let result { return result } }
        throw CancellationError()
      }
      _ = try result.get()
      Issue.record("A cancelled waiter succeeded")
    } catch is CancellationError {} catch {
      await gate.release()
      await first.value
      _ = try? await second.value
      throw error
    }
    await gate.release()
    #expect(try await second.value == "new-token")
    #expect(gate.started.value == 1)
  }
}

extension HttpTransport {
  fileprivate func deliverForTest(_ frame: BusFrame, id: String) throws {
    let connection = UUID()
    connections[connection] = Connection(task: connection, token: "test", previous: [])
    defer { connections.removeValue(forKey: connection) }
    let data = String(decoding: try JSONEncoder().encode(frame), as: UTF8.self)
    received(SSEEvent(event: "bus-event", id: id, data: data), connection: connection)
  }
}
@Test func aMultichannelViewKeepsArrivalOrderAndTraceMetadataSeparate() async throws {
  try await server(.noHeaders) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: nil, channels: ["beckon:focus", "beckon:sparkle"])
    let events = try await transport.frames("beckon:focus", "beckon:sparkle")
    let resource = try ResourceId("resource")
    let trace = ["traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"]
    let payload: [String: JSONValue] = [
      "annotationId": .string("annotation"), traceField: .object(trace.mapValues(JSONValue.string)),
    ]
    for (channel, id) in [
      ("beckon:focus", "p-one"), ("beckon:sparkle", "e-two"), ("beckon:focus", "p-three"),
      ("beckon:sparkle", "e-two"), ("beckon:focus", "e-four"),
    ] {
      try await transport.deliverForTest(
        BusFrame(channel: channel, payload: payload, scope: resource), id: id)
    }
    transport.dispose()
    var received: [ReceivedFrame] = []
    for try await frame in events { received.append(frame) }
    #expect(
      received.map(\.channel) == ["beckon:focus", "beckon:sparkle", "beckon:focus", "beckon:focus"])
    #expect(received.allSatisfy { $0.payload[traceField] == nil && $0.trace == trace })
    #expect(await transport.watermarks[resource] == "p-three")
  }
}

private final class RecordedSpans: SpanExporter {
  private let spans = Mutex<[SpanData]>([])
  func export(spans: [SpanData], explicitTimeout: TimeInterval?) -> SpanExporterResultCode {
    self.spans.withLock { $0.append(contentsOf: spans) }
    return .success
  }
  func flush(explicitTimeout: TimeInterval?) -> SpanExporterResultCode { .success }
  func shutdown(explicitTimeout: TimeInterval?) {}
  func ended(_ resource: String) -> Bool {
    spans.withLock { $0.contains { $0.attributes["resource.id"] == .string(resource) } }
  }
}
@Test func aStreamingReadSpanEndsWhenItsBodyEnds() async throws {
  try await server(.noBody) { base, http in
    let exported = RecordedSpans()
    let traces = TracerProviderBuilder().add(
      spanProcessor: SimpleSpanProcessor(spanExporter: exported)
    ).build()
    OpenTelemetry.registerTracerProvider(tracerProvider: traces)
    defer {
      traces.shutdown()
      OpenTelemetry.registerTracerProvider(tracerProvider: DefaultTracerProvider.instance)
    }
    let transport = HttpTransport(baseUrl: base, httpClient: http, token: "token", channels: [])
    defer { transport.dispose() }
    let resource = UUID().uuidString
    let read = try await transport.getBinaryStream(ResourceId(resource))
    traces.forceFlush()
    #expect(!exported.ended(resource))
    read.dispose()
    try await within(1000) {
      while !exported.ended(resource) { try await sleepMilliseconds(1) }
    }
  }
}
