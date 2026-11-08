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
private enum UploadReply: Sendable {
  case answer(Int, String)
  case unanswered
}
private struct UploadArrival: Sendable, Equatable {
  let key: String?
  let body: Data
}
/// The replies a test's gateway gives the uploads sent to it, in turn. One past the last is held.
private final class UploadScript: Sendable {
  let arrivals = Watched<[UploadArrival]>([])
  private let replies: Mutex<[UploadReply]>
  init(_ replies: [UploadReply]) { self.replies = Mutex(replies) }
  func reply(to arrival: UploadArrival) -> UploadReply? {
    replies.withLock { replies in
      arrivals.set(arrivals.value + [arrival])
      return replies.isEmpty ? nil : replies.removeFirst()
    }
  }
}
private final class UploadEndpoint: ChannelInboundHandler {
  typealias InboundIn = HTTPServerRequestPart
  typealias OutboundOut = HTTPServerResponsePart
  let script: UploadScript
  var key: String?
  var body = Data()
  init(_ script: UploadScript) { self.script = script }
  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    switch unwrapInboundIn(data) {
    case .head(let head):
      key = head.headers.first(name: "Idempotency-Key")
      body = Data()
    case .body(let chunk): body.append(contentsOf: chunk.readableBytesView)
    case .end:
      switch script.reply(to: UploadArrival(key: key, body: body)) {
      case nil: break
      case .unanswered: context.close(promise: nil)
      case .answer(let status, let text):
        let bytes = ByteBuffer(string: text)
        var headers = HTTPHeaders()
        headers.add(name: "Content-Type", value: "application/json")
        headers.add(name: "Content-Length", value: String(bytes.readableBytes))
        let head = HTTPResponseHead(
          version: .http1_1, status: HTTPResponseStatus(statusCode: status), headers: headers)
        context.write(wrapOutboundOut(.head(head)), promise: nil)
        context.write(wrapOutboundOut(.body(.byteBuffer(bytes))), promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
      }
    }
  }
}
/// What a test's gateway does with each connection: a fixed answer, or an upload script.
private enum Gateway: Sendable {
  case answering(Answer)
  case uploads(UploadScript)
  func endpoint() -> any ChannelHandler {
    switch self {
    case .answering(let answer): return Endpoint(answer)
    case .uploads(let script): return UploadEndpoint(script)
    }
  }
}
private func server<Value: Sendable>(
  _ gateway: Gateway, _ run: @Sendable (String, HTTPClient) async throws -> Value
) async throws -> Value {
  let channel = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
    .childChannelInitializer { channel in
      channel.eventLoop.makeCompletedFuture {
        try channel.pipeline.syncOperations.configureHTTPServerPipeline()
        try channel.pipeline.syncOperations.addHandler(gateway.endpoint())
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
  try await server(.answering(.noHeaders)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: ["beckon:focus"],
      timing: TransportTiming(reconnectMs: 500, streamOpenMs: 20))
    defer { transport.dispose() }
    let state = try await withinTestDeadline {
      for await state in transport.state where state == .reconnecting { return state }
      throw CancellationError()
    }
    #expect(state == .reconnecting)
  }
  try await server(.answering(.idleStream)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: ["beckon:focus"],
      timing: TransportTiming(streamOpenMs: 20))
    defer { transport.dispose() }
    try await withinTestDeadline { try await transport.waitUntilOpen() }
    try await Task.sleep(for: .milliseconds(80))
    #expect(transport.state.value == .open)
  }
}
@Test func refusalBodyDeadlinePreservesTheStatus() async throws {
  try await server(.answering(.refusalWithoutBody)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: [],
      timing: TransportTiming(httpRequestMs: 100))
    defer { transport.dispose() }
    do {
      _ = try await withinTestDeadline { try await transport.getCurrentUser() }
      Issue.record("A 401 succeeded")
    } catch let failure as TransportError {
      #expect(failure.status == 401)
      #expect(failure.reason == .unauthorized)
    }
  }
}
@Test func aReadDeadlineIncludesTheBody() async throws {
  try await server(.answering(.noBody)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: [],
      timing: TransportTiming(httpRequestMs: 20))
    defer { transport.dispose() }
    do {
      _ = try await withinTestDeadline { try await transport.getBinary(ResourceId("resource")) }
      Issue.record("An unfinished read succeeded")
    } catch let failure as TransportError { #expect(failure.reason == .unavailable) }
  }
}
@Test func disposalCancelsInFlightGatewayOperations() async throws {
  try await server(.answering(.noHeaders)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: "token", channels: [],
      timing: TransportTiming(httpRequestMs: 5000))
    let request = Task { try await transport.getCurrentUser() }
    try await Task.sleep(for: .milliseconds(20))
    transport.dispose()
    do {
      _ = try await withinTestDeadline { try await request.value }
      Issue.record("A disposed request succeeded")
    } catch is CancellationError {}
  }
}

private let sampleUpload = PutBinaryRequest(
  name: "Sample", file: Data("sent twice, kept once".utf8), format: "text/plain",
  storageUri: "file://uploads/sample.txt")
private func uploadSentOnceMore(after first: UploadReply) async throws {
  let script = UploadScript([first, .answer(202, #"{"resourceId":"uploaded"}"#)])
  let created = try await server(.uploads(script)) { base, http in
    let transport = HttpTransport(baseUrl: base, httpClient: http, token: "token", channels: [])
    defer { transport.dispose() }
    return try await withinTestDeadline {
      try await transport.putBinary(sampleUpload).completed()
    }
  }
  #expect(created.resourceId.value == "uploaded")
  let arrivals = script.arrivals.value
  #expect(arrivals.count == 2)
  #expect(arrivals.first?.key != nil)
  #expect(arrivals.first == arrivals.last)
}
@Test func anUploadAnswered503IsSentOnceMoreWithItsKeyAndBytes() async throws {
  try await uploadSentOnceMore(after: .answer(503, #"{"error":"Unavailable"}"#))
}
@Test func anUploadThatGotNoAnswerIsSentOnceMoreWithItsKeyAndBytes() async throws {
  try await uploadSentOnceMore(after: .unanswered)
}
@Test(arguments: [400, 422])
func aRefusedUploadIsNotSentAgain(status: Int) async throws {
  let script = UploadScript([.answer(status, #"{"error":"Refused"}"#)])
  try await server(.uploads(script)) { base, http in
    let transport = HttpTransport(baseUrl: base, httpClient: http, token: "token", channels: [])
    defer { transport.dispose() }
    do {
      _ = try await withinTestDeadline {
        try await transport.putBinary(sampleUpload).completed()
      }
      Issue.record("A refused upload succeeded")
    } catch let failure as TransportError { #expect(failure.status == status) }
  }
  #expect(script.arrivals.value.count == 1)
}
@Test func aCancelledUploadIsNotSentAgain() async throws {
  let script = UploadScript([])
  try await server(.uploads(script)) { base, http in
    let transport = HttpTransport(baseUrl: base, httpClient: http, token: "token", channels: [])
    defer { transport.dispose() }
    let upload = transport.putBinary(sampleUpload)
    try await withinTestDeadline {
      for await arrivals in script.arrivals where arrivals.count == 1 { return }
    }
    upload.dispose()
    do {
      _ = try await withinTestDeadline { try await upload.completed() }
      Issue.record("A cancelled upload succeeded")
    } catch is CancellationError {}
  }
  #expect(script.arrivals.value.count == 1)
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
  try await server(.answering(.noHeaders)) { base, http in
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
    try await withinTestDeadline { for await count in gate.started where count == 1 { return } }
    let second = Task { try await transport.renew(refused: "old-token") }
    first.cancel()
    do {
      let result = try await withinTestDeadline {
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
  try await server(.answering(.noHeaders)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: nil, channels: ["beckon:focus", "beckon:sparkle"])
    let events = try await transport.frames(["beckon:focus", "beckon:sparkle"])
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
    for try await carried in events {
      guard case .frame(let frame) = carried else {
        Issue.record("A frame BusFrame allows was refused: \(carried)")
        continue
      }
      received.append(frame)
    }
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
  try await server(.answering(.noBody)) { base, http in
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
    let client = try await SemiontClient(transport: transport)
    defer { client.dispose() }
    let resource = UUID().uuidString
    let read = try await client.browse.resourceRepresentationStream(ResourceId(resource))
    traces.forceFlush()
    #expect(!exported.ended(resource))
    read.dispose()
    try await withinTestDeadline {
      while !exported.ended(resource) { try await Task.sleep(for: .milliseconds(1)) }
    }
  }
}

@Test func httpClientBridgesAllDeliveredChannelsIntoItsOwnBus() async throws {
  try await server(.answering(.noHeaders)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: nil, channels: ["beckon:focus", "beckon:sparkle"])
    let client = try await SemiontClient(transport: transport, gateway: transport)
    defer { client.dispose() }
    let focus = client.bus.frames(Channels.beckonFocus)
    let sparkle = client.bus.frames(Channels.beckonSparkle)
    try await transport.deliverForTest(
      BusFrame(channel: "beckon:focus", payload: ["resourceId": .string("resource")]), id: "e-focus"
    )
    try await transport.deliverForTest(
      BusFrame(channel: "beckon:sparkle", payload: ["annotationId": .string("annotation")]),
      id: "e-sparkle")
    let heardFocus = try await withinTestDeadline {
      var iterator = focus.makeAsyncIterator()
      return try await iterator.next()
    }
    let heardSparkle = try await withinTestDeadline {
      var iterator = sparkle.makeAsyncIterator()
      return try await iterator.next()
    }
    guard case .delivered(let first) = heardFocus, case .delivered(let second) = heardSparkle else {
      Issue.record("HTTP frames were not bridged")
      return
    }
    #expect(first.payload.resourceId.value == "resource")
    #expect(second.payload.annotationId.value == "annotation")
  }
}

extension HttpTransport {
  fileprivate func openForTest() {
    start()
    state.set(.open)
  }
  fileprivate func pendingIDForTest() -> String? { pending.keys.first }
}
@Test func nativeRequestsStripUndeclaredStampsAndRefuseMissingReplyMembers() async throws {
  try await server(.answering(.noHeaders)) { base, http in
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: nil,
      channels: [
        Channels.frameEntityTypeAddOk.name, Channels.frameEntityTypeAddFailed.name,
        Channels.browseResourceResult.name, Channels.browseResourceFailed.name,
      ])
    defer { transport.dispose() }
    await transport.openForTest()
    let write = Task {
      try await Bus(transport).request(
        Operations.frameAddEntityType, FrameAddEntityTypeCommand(tag: "Person"))
    }
    let correlation = try await withinTestDeadline {
      while true {
        if let id = await transport.pendingIDForTest() { return id }
        try await Task.sleep(for: .milliseconds(5))
      }
    }
    try await transport.deliverForTest(
      BusFrame(
        channel: Channels.frameEntityTypeAddOk.name, correlationId: correlation,
        payload: ["_userId": .string("did:web:kb.test:users:person")]), id: "e-write")
    _ = try await withinTestDeadline { try await write.value }
    let read = Task {
      try await Bus(transport).request(
        Operations.browseResourceRequested,
        BrowseResourceRequest(resourceId: ResourceId("resource")))
    }
    let next = try await withinTestDeadline {
      while true {
        if let id = await transport.pendingIDForTest() { return id }
        try await Task.sleep(for: .milliseconds(5))
      }
    }
    try await transport.deliverForTest(
      BusFrame(
        channel: Channels.browseResourceResult.name, correlationId: next,
        payload: ["response": .object(["lastSequence": .number(1)])]), id: "e-read")
    do {
      _ = try await withinTestDeadline { try await read.value }
      Issue.record("Malformed native reply succeeded")
    } catch let error as TransportError {
      #expect(error.reason == .error)
      #expect(error.description.contains("response.resource"))
    }
  }
}

@Test func httpClientFactoryOwnsItsTransportAndRefusesCancelledConstruction() async throws {
  try await server(.answering(.noHeaders)) { base, http in
    let client = try await SemiontClient.fromHttp(baseUrl: base, httpClient: http)
    #expect(client.auth != nil && client.system != nil)
    #expect(client.baseUrl == base)
    client.dispose()
    #expect(client.state.value == .closed)
    let cancelled = Task {
      withUnsafeCurrentTask { $0?.cancel() }
      return try await SemiontClient.fromHttp(baseUrl: base, httpClient: http)
    }
    do {
      _ = try await cancelled.value
      Issue.record("Cancelled factory succeeded")
    } catch is CancellationError {}
  }
}

// A failure is held to its channel's schema as a result is: one with no words,
// or with a code that is no text, is not its channel's, and is refused naming
// its first fault. One whose code the wire does not list keeps its words.
@Test(arguments: ["listed", "unlisted", "wordless", "codeIsNoText"])
func nativeRequestsReadFailuresByTheirChannelsSchema(failure: String) async throws {
  try await server(.answering(.noHeaders)) { base, http in
    let operation = Operations.frameAddEntityType
    let transport = HttpTransport(
      baseUrl: base, httpClient: http, token: nil,
      channels: [operation.result.name, operation.failure.name])
    defer { transport.dispose() }
    await transport.openForTest()
    let request = Task {
      try await transport.request(
        operation: operation.request.name,
        payload: wirePayload(FrameAddEntityTypeCommand(tag: "Person")))
    }
    let correlation = try await withinTestDeadline {
      while true {
        if let id = await transport.pendingIDForTest() { return id }
        try await Task.sleep(for: .milliseconds(5))
      }
    }
    let listed = try wirePayload(CommandError(code: .peerUnavailable, message: "still starting"))
    let payload: [String: JSONValue] =
      switch failure {
      case "listed": listed
      case "unlisted":
        ["message": .string("a code from a later peer"), "code": .string("not-a-code-yet")]
      case "wordless": ["code": .string("not-found")]
      default: ["message": .string("refused"), "code": .number(7)]
      }
    try await transport.deliverForTest(
      BusFrame(channel: operation.failure.name, correlationId: correlation, payload: payload),
      id: "e-failure")
    let refused = "a payload on \(operation.failure.name) is not that channel's: "
    do {
      _ = try await withinTestDeadline { try await request.value }
      Issue.record("A failed native request succeeded")
    } catch let error as BusRequestError {
      switch failure {
      case "listed":
        #expect(error.reason == .busPeerUnavailable)
        #expect(error.description == "still starting")
      case "unlisted":
        #expect(error.reason == unrecognizedBusFailure)
        #expect(error.description == "a code from a later peer")
      default: Issue.record("A failure that is not its channel's was read: \(error)")
      }
    } catch let error as TransportError {
      #expect(error.reason == .error)
      switch failure {
      case "wordless": #expect(error.description == refused + "it has no `message`")
      case "codeIsNoText": #expect(error.description == refused + "its `code` is malformed")
      default: Issue.record("A failure of its channel's was refused: \(error)")
      }
    }
  }
}
