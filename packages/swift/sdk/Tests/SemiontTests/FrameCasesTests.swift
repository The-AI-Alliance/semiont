import AsyncHTTPClient
import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import Testing

@testable import Semiont

// The stream's reader, held to protocol/specs/src/bus/frame-cases.json: the table every SDK's
// stream reader runs. Each case's line is read as the `data` of a `bus-event` the stream carried,
// followed by a line that names no channel and a frame of `beckon:focus` read cleanly. What the
// transport delivers, what a typed read of the case's channel is given, what the failure report is
// told before that line, and what becomes of a request awaiting the case's reply are each held to
// the case; the frame's coming shows the stream went on. A delivered frame on a channel this
// runner reads by type is read so too, and what its typed reader reads is held to the case's
// `read`, or to the payload as the frame states it. A request chooses its own correlation id, so a
// request's case is carried with that id in place of the table's.

/// The channel every case told to its readers is on but a request's, read here by type.
private let read = Channels.beckonFocus

/// The replies a request's case awaits, of `browse:resource-requested`: the first is the channel
/// its readers are told on.
private let replies = [Channels.browseResourceResult.name, Channels.browseResourceFailed.name]

/// A typed reader of one channel over a transport, made before the case's line is carried.
private struct TypedReading: Sendable {
  /// What it reads of the first frame it is given: the payload it decoded, as the wire states it,
  /// or nil for a refusal.
  let first: @Sendable () async throws -> JSONValue?
}

private func readingByType<Payload>(_ channel: Semiont.Channel<Payload>)
  -> @Sendable (HttpTransport) async throws -> TypedReading
{
  { transport in
    let typed = try await Bus(transport).frames(channel)
    return TypedReading {
      guard case .delivered(let delivered)? = try await first(1, of: typed).first else {
        return nil
      }
      return .object(try wirePayload(delivered.payload))
    }
  }
}

/// The channels a delivered case's payload is read on by type, as the table names them, and their
/// typed readers.
private let typedReaders: [String: @Sendable (HttpTransport) async throws -> TypedReading] = [
  read.name: readingByType(read),
  Channels.browseResourceFailed.name: readingByType(Channels.browseResourceFailed),
  Channels.gatherFailed.name: readingByType(Channels.gatherFailed),
]

/// The correlation id the table names the request awaiting a case's reply by.
private let awaited = "c-1"

/// A line that names no channel: what the failure report is told after each case's line.
private let namesNoChannel = "{"

/// The frame each case's line is followed by, read cleanly.
private let after = #"{"channel": "beckon:focus", "payload": {"resourceId": "after"}}"#

private func isAfter(_ heard: Heard<BeckonFocusEvent>) -> Bool {
  guard case .delivered(let delivered) = heard else { return false }
  return delivered.payload.resourceId.value == "after"
}

/// What a typed reader is given, as a case states it: a refusal, or none for a payload it heard.
private func refusalOf<Payload>(_ heard: Heard<Payload>) -> FrameRefusal? {
  guard case .refused(let refusal) = heard else { return nil }
  return refusal
}

private func isTheFrameAfter(_ carried: Carried) -> Bool {
  guard case .frame(let frame) = carried else { return false }
  return frame.payload["resourceId"] == .string("after")
}

/// What the failure report is told, as a case states it.
private struct Told: Equatable, CustomStringConvertible {
  let reason: TransportErrorCode
  let status: Int?
  let words: String
  init(_ failure: TransportError) {
    reason = failure.reason
    status = failure.status
    words = failure.description
  }
  init(_ fault: Fault) {
    reason = .error
    status = nil
    words = "the stream carried what is not a frame: \(fault.said)"
  }
  var description: String { "\(reason) \(status.map(String.init) ?? "-") \(words)" }
}

/// What `source` gives up to the first that `last` holds of, and without it.
private func before<Source: AsyncSequence & Sendable>(
  _ source: Source, _ last: @escaping @Sendable (Source.Element) -> Bool
) async throws -> [Source.Element] where Source.Element: Sendable {
  try await withinTestDeadline {
    var came: [Source.Element] = []
    for try await element in source {
      if last(element) { return came }
      came.append(element)
    }
    throw SpecFailure.shape("the stream ended before the frame after the case's line")
  }
}

/// The first `count` that `source` gives.
private func first<Source: AsyncSequence & Sendable>(_ count: Int, of source: Source)
  async throws -> [Source.Element] where Source.Element: Sendable
{
  try await withinTestDeadline {
    var came: [Source.Element] = []
    for try await element in source {
      came.append(element)
      if came.count == count { return came }
    }
    throw SpecFailure.shape("the stream ended after \(came.count) of \(count)")
  }
}

/// Each failure `transport` tells a listener taken now, in the order told.
private func failuresTold(by transport: HttpTransport) -> AsyncStream<TransportError> {
  let (told, telling) = AsyncStream<TransportError>.makeStream()
  transport.tellFailures { telling.yield($0) }
  return told
}

/// A gateway that answers nothing: an emit sent to it is never answered, so a request goes on
/// awaiting its reply until the case settles it.
private final class Unanswering: ChannelInboundHandler {
  typealias InboundIn = HTTPServerRequestPart
  func channelRead(context: ChannelHandlerContext, data: NIOAny) {}
}

/// A transport over a gateway that answers nothing, its stream open, for `run`.
private func carrying(_ run: @Sendable (HttpTransport) async throws -> Void) async throws {
  let channel = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
    .childChannelInitializer { channel in
      channel.eventLoop.makeCompletedFuture {
        try channel.pipeline.syncOperations.configureHTTPServerPipeline()
        try channel.pipeline.syncOperations.addHandler(Unanswering())
      }
    }.bind(host: "127.0.0.1", port: 0).get()
  let port = try #require(channel.localAddress?.port)
  let http = HTTPClient(eventLoopGroupProvider: .singleton)
  let transport = HttpTransport(
    baseUrl: "http://127.0.0.1:\(port)", httpClient: http, token: nil,
    channels: Set(typedReaders.keys).union(replies).sorted())
  await transport.openedForTest()
  do {
    try await run(transport)
    transport.dispose()
    try await http.shutdown()
    try await channel.close().get()
  } catch {
    transport.dispose()
    try? await http.shutdown()
    try? await channel.close().get()
    throw error
  }
}

extension HttpTransport {
  fileprivate func openedForTest() {
    start()
    state.set(.open)
  }
  fileprivate func awaitingForTest() -> String? { pending.keys.first }
  /// `data`, as the `data` line of a `bus-event` the stream carried with the id `id`.
  fileprivate func carryForTest(_ data: String, id: String) {
    let connection = UUID()
    connections[connection] = Connection(task: connection, token: "test", previous: [])
    defer { connections.removeValue(forKey: connection) }
    received(SSEEvent(event: "bus-event", id: id, data: data), connection: connection)
  }
}

private func frameCases() throws -> [[String: JSONValue]] {
  try required(Spec.read("bus/frame-cases.json").object, "cases").array.map { try $0.object }
}

private func line(_ frame: [String: JSONValue]) throws -> String {
  String(decoding: try JSONEncoder().encode(JSONValue.object(frame)), as: UTF8.self)
}

/// The request awaiting the reply of `browse:resource-requested`, and the correlation id it chose.
private func awaitingReply(_ transport: HttpTransport) async throws -> (
  Task<BrowseResourceResult, any Error>, String
) {
  let request = Task {
    try await Bus(transport).request(
      Operations.browseResourceRequested, BrowseResourceRequest(resourceId: ResourceId("resource"))
    )
  }
  let correlation = try await withinTestDeadline {
    while true {
      if let id = await transport.awaitingForTest() { return id }
      try await Task.sleep(for: .milliseconds(5))
    }
  }
  return (request, correlation)
}

@Test func theTableHasAFrameOfEachKind() throws {
  let cases = try frameCases()
  let refused = cases.filter { $0["refused"] == .bool(true) }
  #expect(refused.count < cases.count)
  let stated = { (key: String) in Set(try refused.compactMap { try $0[key]?.text }) }
  #expect(try stated("reason") == ["lacks", "malformed"])
  #expect(try stated("told") == ["readers", "failure-report"])
  #expect(try stated("request") == ["fails", "waits"])
}

@Test func aFrameBusFrameAllowsIsDeliveredAsItStatesIt() async throws {
  for value in try frameCases() where value["refused"] == nil {
    let why = try required(value, "why").text
    #expect(Set(value.keys).subtracting(["read"]) == ["why", "frame"], "\(why)")
    let stated = try required(value, "frame").object
    let channel = try required(stated, "channel").text
    let reader = typedReaders[channel]
    if value["read"] != nil, reader == nil {
      Issue.record("it states what a typed reader of \(channel) reads, and none is made: \(why)")
      continue
    }
    // What its typed reader reads is the payload as the frame states it, unless the case says.
    let expected = value["read"] ?? stated["payload"]
    try await carrying { transport in
      let frames = try await transport.frames([channel])
      let typed = try await reader?(transport)
      let failures = failuresTold(by: transport)
      await transport.carryForTest(try line(stated), id: "e-1")
      await transport.carryForTest(namesNoChannel, id: "e-2")
      guard case .frame(let frame)? = try await first(1, of: frames).first else {
        Issue.record("it is not delivered: \(why)")
        return
      }
      #expect(try frame.channel == required(stated, "channel").text, "\(why)")
      #expect(JSONValue.object(frame.payload) == stated["payload"], "\(why)")
      #expect(frame.correlationId.map(JSONValue.string) == stated["correlationId"], "\(why)")
      #expect(frame.scope.map { JSONValue.string($0.value) } == stated["scope"], "\(why)")
      if let typed { #expect(try await typed.first() == expected, "\(why)") }
      #expect(try await first(1, of: failures).map(Told.init) == [Told(.undecoded)], "\(why)")
    }
  }
}

@Test func aFrameBusFrameDoesNotAllowIsRefusedForTheFaultTheTableStatesAndToldToWhomItStates()
  async throws
{
  for value in try frameCases() where value["refused"] == .bool(true) {
    let why = try required(value, "why").text
    let data = try value["data"]?.text
    let stated = try value["frame"]?.object
    let given = Set(value.keys).subtracting(["correlationId", "request"])
    #expect(
      given == ["why", data == nil ? "frame" : "data", "refused", "member", "reason", "told"],
      "\(why)")
    let reason = try #require(FrameRefusalReason(rawValue: required(value, "reason").text))
    let fault = Fault(member: try required(value, "member").text, reason: reason)
    let told = try required(value, "told").text
    let request = try value["request"]?.text
    let replied = stated?["channel"] == .string(replies[0])
    let channel = replied ? replies[0] : read.name
    try await carrying { transport in
      let awaiting = request == nil ? nil : try await awaitingReply(transport)
      // A request chooses its own correlation id: the case's frame is carried with it.
      let correlation: (JSONValue?) -> JSONValue? = { stated in
        guard let awaiting, stated == .string(awaited) else { return stated }
        return .string(awaiting.1)
      }
      var frame = stated
      frame?["correlationId"] = correlation(stated?["correlationId"])
      let frames = try await transport.frames([channel])
      let typed = try await Bus(transport).frames(read)
      let typedReply = try await Bus(transport).frames(Channels.browseResourceResult)
      let failures = failuresTold(by: transport)
      let text: String
      if let data { text = data } else { text = try line(#require(frame)) }
      await transport.carryForTest(text, id: "e-1")
      await transport.carryForTest(namesNoChannel, id: "e-2")
      await transport.carryForTest(after, id: "e-3")
      let readByType = try await before(typed, isAfter)
      // A reply's channel carries nothing but the case's line, and the frame after it is on another.
      let carried = try await replied ? first(1, of: frames) : before(frames, isTheFrameAfter)
      let heard =
        try await replied ? first(1, of: typedReply).map(refusalOf) : readByType.map(refusalOf)
      switch told {
      case "readers":
        let frame = try #require(frame, "\(why)")
        #expect(frame["channel"] == .string(channel), "\(why)")
        guard heard.count == 1, let refusal = heard[0] else {
          Issue.record("its typed reader is given \(heard), not its refusal: \(why)")
          return
        }
        #expect(refusal.channel == channel, "\(why)")
        #expect(refusal.member == fault.member, "\(why)")
        #expect(refusal.reason == fault.reason, "\(why)")
        #expect(refusal.payload == frame["payload"], "\(why)")
        // A null where a member may be absent is its absence, as BusFrame reads it.
        let scope = frame["scope"] == .null ? nil : frame["scope"]
        #expect(refusal.scope.map { JSONValue.string($0.value) } == scope, "\(why)")
        #expect(
          refusal.correlationId.map(JSONValue.string) == correlation(value["correlationId"]),
          "\(why)")
        // A payload that is not its channel's is its typed reader's to refuse: the transport
        // delivers its frame.
        if fault.member.hasPrefix("payload.") {
          guard carried.count == 1, case .frame(let delivered) = carried[0] else {
            Issue.record("the transport delivers \(carried), not the frame: \(why)")
            return
          }
          #expect(JSONValue.object(delivered.payload) == frame["payload"], "\(why)")
        } else {
          guard carried.count == 1, case .refused(let delivered) = carried[0] else {
            Issue.record("the transport delivers \(carried), not the refusal: \(why)")
            return
          }
          #expect(delivered == refusal, "\(why)")
        }
        #expect(try await first(1, of: failures).map(Told.init) == [Told(.undecoded)], "\(why)")
      case "failure-report":
        #expect(carried.isEmpty, "the transport delivers \(carried): \(why)")
        #expect(heard.isEmpty, "its typed reader is given \(heard): \(why)")
        #expect(
          try await first(2, of: failures).map(Told.init) == [Told(fault), Told(.undecoded)],
          "\(why)")
      default:
        Issue.record("told to whom the table does not give: \(told)")
      }
      guard let awaiting else { return }
      let (reading, id) = awaiting
      switch request {
      case "fails"?:
        do {
          _ = try await withinTestDeadline { try await reading.value }
          Issue.record("the request awaiting the reply is answered: \(why)")
        } catch let failure as TransportError {
          #expect(failure.reason == .error, "\(why)")
          #expect(
            failure.description
              == "a frame on \(channel) is not that channel's: \(fault.said)", "\(why)")
        }
      case "waits"?:
        // The frame after the case's line has been read, so the line has been read in full.
        #expect(await transport.awaitingForTest() == id, "the request goes on awaiting: \(why)")
        reading.cancel()
      default:
        Issue.record("a request the table does not give: \(String(describing: request))")
      }
    }
  }
}
