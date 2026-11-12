import AsyncHTTPClient
import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import Synchronization
import Testing

@testable import Semiont
@testable import SemiontTesting

// The time a client keeps, against protocol/specs/src/client/clock-cases.json. Each case builds its
// subject over a network faked in this process, on a TestClock that moves only when the case moves
// it, at this SDK's timings, which are the table's, and with a random source whose every draw is
// the lowest it can give. A `pass` moves the clock to each instant a sleeper falls due on the way,
// in turn, and lets what falls due run there, so a wait ends at the instant it was set to end, or
// the case fails. What the table may say is held by .github/scripts/checks/specs/check-case-tables.mjs.

private func clockCases() throws -> [[String: JSONValue]] {
  try required(Spec.read("client/clock-cases.json").object, "cases").array.map { try $0.object }
}

private struct ClockCaseFailure: Error, CustomStringConvertible {
  let description: String
  init(_ description: String) { self.description = description }
}

private struct LowestDraw: RandomNumberGenerator, Sendable {
  // A bounded draw maps 1 to the bottom of its range; it rejects 0, and draws again, for ever.
  mutating func next() -> UInt64 { 1 }
}

private final class Counter: Sendable {
  private let value = Mutex(0)
  @discardableResult func add() -> Int {
    value.withLock {
      $0 += 1
      return $0
    }
  }
  var count: Int { value.withLock { $0 } }
}

/// A count of the values `watched` comes to hold that `counts` counts, from now on, and its reader.
private func tally<Value: Sendable>(
  _ watched: Watched<Value>, _ counts: @escaping @Sendable (Value) -> Bool
) -> (Counter, Task<Void, Never>) {
  let counter = Counter()
  let values = watched.observations()
  let reader = Task {
    for await value in values where counts(value) { counter.add() }
  }
  return (counter, reader)
}

// ── Settling ────────────────────────────────────────────────────────────

private struct Stillness: Equatable {
  let wakes: [TestClock.Instant]
  let activity: Int
}

/// Lets what is ready run, and what that makes ready, without moving the clock: until neither the
/// clock's sleepers nor what the subject has done have changed over `settleLooks` looks in a row,
/// and `pending` names nothing. What runs is real work on real threads, the faked network's
/// included, so a settle waits real time. Stillness alone cannot tell slow work from none: on a
/// loaded runner a client can take longer than any number of looks to read an answer or to close a
/// stream, and neither shows in the clock or the network until it is done. What the runner knows
/// is owed, `pending` names, and the settle waits it out however long it takes, the clock still.
private func waitUntilStill(
  _ clock: TestClock, _ activity: @Sendable () -> Int,
  pending: @Sendable () async -> String?
) async throws {
  var seen = Stillness(wakes: clock.wakes, activity: activity())
  var still = 0
  var looks = 0
  while still < settleLooks {
    try await Task.sleep(for: settleLook)
    looks += 1
    let owed = await pending()
    guard looks < settleLookLimit else {
      if let owed { throw ClockCaseFailure("it did not settle: \(owed)") }
      throw ClockCaseFailure("it did not settle")
    }
    let now = Stillness(wakes: clock.wakes, activity: activity())
    still = now == seen && owed == nil ? still + 1 : 0
    seen = now
  }
}
private let settleLook = Duration.milliseconds(5)
private let settleLooks = 8
private let settleLookLimit = 1000

// ── What a case drives ──────────────────────────────────────────────────

private struct Subject: Sendable {
  /// How many times what the subject counts has happened since the case began.
  let counted: @Sendable () -> Int
  /// A count that grows with everything the subject does that a settle waits out: what it counts,
  /// and what its network has been asked.
  let activity: @Sendable () -> Int
  /// What the subject has been handed and has yet to finish, or nil once it has finished it all.
  let pending: @Sendable () async -> String?
  let act: (@Sendable () async throws -> Void)?
  let close: @Sendable () async throws -> Void
}

private typealias Build = @Sendable ([String: JSONValue], TestClock) async throws -> Subject

private func givenSeconds(_ given: [String: JSONValue], _ name: String) throws -> Int? {
  try given[name].map(stateCaseInteger)
}

private final class Holding: Sendable {
  private let holds = Mutex<[ResourceHold]>([])
  func keep(_ hold: ResourceHold) { holds.withLock { $0.append(hold) } }
}

// ── The network ─────────────────────────────────────────────────────────

/// A request the network was asked.
private struct Asked: Sendable {
  let path: String
  /// The scheme and the host the request named.
  let origin: String
  /// How many requests of its path the network has been asked, it among them.
  let nth: Int
}

private enum Reply: Sendable {
  case json(Int, [String: String], JSONValue)
  /// A stream held open, on which nothing is said.
  case held
  /// No answer at all.
  case silent
}

/// What a network in this process answers, and what it has heard: each request answered at once,
/// as `route` has it.
private final class Ledger: Sendable {
  private struct Heard: Sendable {
    var asked: [String: Int] = [:]
    var held = 0
    var closed = 0
    var events = 0
    var unrouted: [String] = []
  }
  private let route: @Sendable (Asked) -> Reply?
  private let heard = Mutex(Heard())
  init(_ route: @escaping @Sendable (Asked) -> Reply?) { self.route = route }

  func answer(path: String, origin: String) -> Reply {
    let nth = heard.withLock { heard in
      heard.events += 1
      heard.asked[path, default: 0] += 1
      return heard.asked[path, default: 0]
    }
    if let reply = route(Asked(path: path, origin: origin, nth: nth)) {
      if case .held = reply { heard.withLock { $0.held += 1 } }
      return reply
    }
    heard.withLock { $0.unrouted.append(path) }
    return .json(404, [:], .object(["error": .string("No route for \(path)")]))
  }
  func closedStream() {
    heard.withLock { heard in
      heard.closed += 1
      heard.events += 1
    }
  }
  func asked(_ path: String) -> Int { heard.withLock { $0.asked[path, default: 0] } }
  /// How many of the streams it held open their readers have closed.
  var closed: Int { heard.withLock { $0.closed } }
  /// How many streams it holds open that their readers have not closed.
  var heldOpen: Int { heard.withLock { $0.held - $0.closed } }
  var events: Int { heard.withLock { $0.events } }
  var unrouted: [String] { heard.withLock { $0.unrouted } }
}

private final class Answering: ChannelInboundHandler {
  typealias InboundIn = HTTPServerRequestPart
  typealias OutboundOut = HTTPServerResponsePart
  private let ledger: Ledger
  private var head: HTTPRequestHead?
  private var holding = false
  init(_ ledger: Ledger) { self.ledger = ledger }
  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    switch unwrapInboundIn(data) {
    case .head(let head): self.head = head
    case .body: break
    case .end:
      guard let head, let host = head.headers.first(name: "Host") else { return }
      let path = String(head.uri.prefix { $0 != "?" })
      switch ledger.answer(path: path, origin: "http://" + host) {
      case .silent: break
      case .held:
        holding = true
        let headers = HTTPHeaders([
          ("Content-Type", "text/event-stream"), ("Content-Length", "1000000"),
        ])
        context.writeAndFlush(
          wrapOutboundOut(
            .head(HTTPResponseHead(version: .http1_1, status: .ok, headers: headers))),
          promise: nil)
      case .json(let status, let stated, let body):
        guard let encoded = try? JSONEncoder().encode(body) else { return }
        var headers = HTTPHeaders([
          ("Content-Type", "application/json"), ("Content-Length", String(encoded.count)),
        ])
        for (name, value) in stated { headers.add(name: name, value: value) }
        let response = HTTPResponseHead(
          version: .http1_1, status: HTTPResponseStatus(statusCode: status), headers: headers)
        context.write(wrapOutboundOut(.head(response)), promise: nil)
        context.write(wrapOutboundOut(.body(.byteBuffer(ByteBuffer(bytes: encoded)))), promise: nil)
        context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
      }
    }
  }
  func channelInactive(context: ChannelHandlerContext) {
    if holding { ledger.closedStream() }
    context.fireChannelInactive()
  }
}

private struct Loopback: Sendable {
  let base: String
  let port: Int
  let http: HTTPClient
  let server: any NIOCore.Channel
  static func open(_ ledger: Ledger) async throws -> Loopback {
    let server = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
      .childChannelInitializer { channel in
        channel.eventLoop.makeCompletedFuture {
          // Pipelining assistance stops reading a connection until its response ends, and a held
          // stream's never does. On kqueue a peer's close is seen only by reading, so it would
          // never reach channelInactive there; epoll reports it unasked.
          try channel.pipeline.syncOperations.configureHTTPServerPipeline(
            withPipeliningAssistance: false)
          try channel.pipeline.syncOperations.addHandler(Answering(ledger))
        }
      }.bind(host: "127.0.0.1", port: 0).get()
    guard let port = server.localAddress?.port else {
      throw ClockCaseFailure("The loopback network has no port")
    }
    return Loopback(
      base: "http://127.0.0.1:\(port)", port: port,
      http: HTTPClient(eventLoopGroupProvider: .singleton), server: server)
  }
  func close() async throws {
    try await http.shutdown()
    try await server.close().get()
  }
}

// ── The gateway ─────────────────────────────────────────────────────────

private let subscribePath = "/bus/subscribe"
private let emitPath = "/bus/emit"
private let healthPath = "/api/health"

private enum StreamAnswer: Sendable { case holds, refuses, never }

private struct Gateway: Sendable {
  let stream: StreamAnswer
  let ledger: Ledger
  let loopback: Loopback
  let transport: HttpTransport

  /// A gateway that answers a subscribe as `stream` says, refuses the paths `refused` names with a
  /// 503, and never answers the paths `unanswered` names, and a transport to it, holding a token, so
  /// its stream is set going. Its refusals carry a `Retry-After` of `retryAfterSeconds`, when it
  /// states one.
  static func open(
    _ stream: StreamAnswer, retryAfterSeconds: Int? = nil, refused: Set<String> = [],
    unanswered: Set<String> = [], clock: TestClock
  ) async throws -> Gateway {
    var stated: [String: String] = [:]
    if let retryAfterSeconds { stated["Retry-After"] = String(retryAfterSeconds) }
    let refusal = Reply.json(503, stated, .object(["error": .string("The gateway is not ready")]))
    let ledger = Ledger { asked in
      if unanswered.contains(asked.path) { return .silent }
      if refused.contains(asked.path) { return refusal }
      guard asked.path == subscribePath else { return nil }
      switch stream {
      case .holds: return .held
      case .never: return .silent
      case .refuses: return refusal
      }
    }
    let loopback = try await Loopback.open(ledger)
    let transport = HttpTransport(
      baseUrl: loopback.base, httpClient: loopback.http, token: "a-token",
      channels: bridgedChannels, clock: clock, random: LowestDraw())
    return Gateway(stream: stream, ledger: ledger, loopback: loopback, transport: transport)
  }

  /// What the client has yet to finish of what passed between it and the gateway, or nil once it
  /// has finished it all: a stream the gateway answered that the client has not taken in, or a
  /// stream the client let go whose close the gateway has not seen. A gateway that never answers a
  /// stream leaves an opening stream nothing to take in.
  func unfinished() async -> String? {
    guard stream != .never else { return nil }
    if await transport.connecting != nil { return "the client is opening a stream" }
    let streams = await transport.connections.count
    let held = ledger.heldOpen
    guard streams == held else {
      return "the client keeps \(streams) streams and the gateway holds \(held) open"
    }
    return nil
  }

  func close() async throws {
    transport.dispose()
    try await loopback.close()
    let unrouted = ledger.unrouted
    guard unrouted.isEmpty else {
      throw ClockCaseFailure("The gateway was asked \(unrouted), which the subject does not answer")
    }
  }
}

private func refusedStream(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject
{
  let gateway = try await Gateway.open(
    .refuses, retryAfterSeconds: givenSeconds(given, "retryAfterSeconds"), clock: clock)
  return Subject(
    counted: { gateway.ledger.asked(subscribePath) }, activity: { gateway.ledger.events },
    pending: { await gateway.unfinished() }, act: nil,
    close: gateway.close)
}

private func unansweredStream(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let gateway = try await Gateway.open(.never, clock: clock)
  return Subject(
    counted: { gateway.ledger.asked(subscribePath) }, activity: { gateway.ledger.events },
    pending: { await gateway.unfinished() }, act: nil,
    close: gateway.close)
}

private func degradedStream(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let gateway = try await Gateway.open(
    .refuses, retryAfterSeconds: givenSeconds(given, "retryAfterSeconds"), clock: clock)
  let (degraded, reader) = tally(gateway.transport.state) { $0 == .degraded }
  return Subject(
    counted: { degraded.count }, activity: { gateway.ledger.events + degraded.count },
    pending: { await gateway.unfinished() }, act: nil,
    close: {
      reader.cancel()
      try await gateway.close()
    })
}

private func scopeTaken(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject {
  let gateway = try await Gateway.open(.holds, clock: clock)
  let holding = Holding()
  let resource = try ResourceId("res-1")
  return Subject(
    counted: { gateway.ledger.asked(subscribePath) }, activity: { gateway.ledger.events },
    pending: { await gateway.unfinished() },
    act: { holding.keep(await gateway.transport.subscribeToResource(resource)) },
    close: gateway.close)
}

private func scopeLetGo(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject {
  let gateway = try await Gateway.open(.holds, clock: clock)
  try await waitUntilStill(
    clock, { gateway.ledger.events }, pending: { await gateway.unfinished() })
  guard gateway.transport.state.value == .open else {
    throw ClockCaseFailure("The stream did not open: it is \(gateway.transport.state.value)")
  }
  let hold = await gateway.transport.subscribeToResource(try ResourceId("res-1"))
  return Subject(
    counted: { gateway.ledger.asked(subscribePath) }, activity: { gateway.ledger.events },
    pending: { await gateway.unfinished() },
    act: { hold.dispose() }, close: gateway.close)
}

private func handoffLinger(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let gateway = try await Gateway.open(.holds, clock: clock)
  let holding = Holding()
  let resource = try ResourceId("res-1")
  return Subject(
    counted: { gateway.ledger.closed }, activity: { gateway.ledger.events },
    pending: { await gateway.unfinished() },
    act: { holding.keep(await gateway.transport.subscribeToResource(resource)) },
    close: gateway.close)
}

private func unansweredRequest(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let gateway = try await Gateway.open(.holds, unanswered: [healthPath], clock: clock)
  let unanswered = Counter()
  let asking = Task {
    do { _ = try await gateway.transport.healthCheck() } catch let failure as TransportError
      where failure.status == nil
    { unanswered.add() }
  }
  return Subject(
    counted: { unanswered.count }, activity: { gateway.ledger.events + unanswered.count },
    pending: { await gateway.unfinished() },
    act: nil,
    close: {
      asking.cancel()
      try await gateway.close()
    })
}

private func unansweredEmit(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let gateway = try await Gateway.open(.holds, unanswered: [emitPath], clock: clock)
  let emitting = Task {
    try await gateway.transport.emit(
      channel: "beckon:hover", payload: ["annotationId": .string("ann-1")])
  }
  return Subject(
    counted: { gateway.ledger.asked(emitPath) }, activity: { gateway.ledger.events },
    pending: { await gateway.unfinished() }, act: nil,
    close: {
      emitting.cancel()
      try await gateway.close()
    })
}

/// How a bus request ended.
private enum Ending: Sendable, Equatable {
  case answered
  case timedOut
  case otherwise(String)
}

private final class Ended: Sendable {
  private let ending = Mutex<Ending?>(nil)
  func tell(_ ended: Ending) { ending.withLock { $0 = ended } }
  var value: Ending? { ending.withLock { $0 } }
}

/// A bus request of a resource's events, made as the case begins by a bus on the case's clock,
/// which keeps the request's deadline, over a gateway that holds its stream open and refuses every
/// emit; how it ended, once it has; and the task that asks it.
private func refusedRequest(_ given: [String: JSONValue], _ clock: TestClock) async throws -> (
  Gateway, Ended, Task<Void, Never>
) {
  let gateway = try await Gateway.open(
    .holds, retryAfterSeconds: givenSeconds(given, "retryAfterSeconds"), refused: [emitPath],
    clock: clock)
  let ended = Ended()
  let bus = Bus(gateway.transport, clock: clock)
  let asking = Task {
    do {
      _ = try await bus.request(
        Operations.browseEventsRequested, BrowseEventsRequest(resourceId: try ResourceId("res-1")))
      ended.tell(.answered)
    } catch let failure as BusRequestError where failure.reason == .busTimeout {
      ended.tell(.timedOut)
    } catch {
      ended.tell(.otherwise("\(error)"))
    }
  }
  return (gateway, ended, asking)
}

private func refusedBusRequest(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  // How the request fails is what timedOutBusRequest counts.
  let (gateway, _, asking) = try await refusedRequest(given, clock)
  return Subject(
    counted: { gateway.ledger.asked(emitPath) }, activity: { gateway.ledger.events },
    pending: { await gateway.unfinished() }, act: nil,
    close: {
      asking.cancel()
      try await gateway.close()
    })
}

private func timedOutBusRequest(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let (gateway, ended, asking) = try await refusedRequest(given, clock)
  return Subject(
    counted: { ended.value == .timedOut ? 1 : 0 },
    activity: { gateway.ledger.events + (ended.value == nil ? 0 : 1) },
    pending: { await gateway.unfinished() }, act: nil,
    close: {
      asking.cancel()
      try await gateway.close()
      if case .otherwise(let failure) = ended.value {
        throw ClockCaseFailure("The request ended otherwise: \(failure)")
      }
    })
}

// ── The issuer ──────────────────────────────────────────────────────────

private let issuerPath = "/realms/semiont"

/// A knowledge base that trusts an issuer, and the issuer: what a device grant asks. Its code lives
/// 900 seconds, with the interval the case states, and its token endpoint answers each ask with the
/// next of the case's answers, the last repeating.
private func deviceGrant(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject {
  let interval = try givenSeconds(given, "intervalSeconds")
  let answers = try required(given, "answers").array.map { try $0.text }
  guard !answers.isEmpty else { throw ClockCaseFailure("The token endpoint has no answers") }
  let ledger = Ledger { asked in
    let issuer = asked.origin + issuerPath
    switch asked.path {
    case "/.well-known/oauth-protected-resource":
      return .json(
        200, [:],
        .object([
          "resource": .string(asked.origin), "authorization_servers": .array([.string(issuer)]),
          "bearer_methods_supported": .array([.string("header")]),
        ]))
    case issuerPath + "/.well-known/openid-configuration":
      return .json(
        200, [:],
        .object([
          "issuer": .string(issuer), "authorization_endpoint": .string(issuer + "/auth"),
          "token_endpoint": .string(issuer + "/token"),
          "device_authorization_endpoint": .string(issuer + "/device"),
        ]))
    case issuerPath + "/device":
      var minted: [String: JSONValue] = [
        "device_code": .string("the-device-code"), "user_code": .string("WDJB-MJHT"),
        "verification_uri": .string(asked.origin + "/device"), "expires_in": .number(900),
      ]
      if let interval { minted["interval"] = .number(Double(interval)) }
      return .json(200, [:], .object(minted))
    case issuerPath + "/token":
      return .json(
        400, [:], .object(["error": .string(answers[min(asked.nth, answers.count) - 1])]))
    default: return nil
    }
  }
  let loopback = try await Loopback.open(ledger)
  let kb = KbTarget(
    endpoint: .httpEndpoint(HttpEndpoint(host: "127.0.0.1", port: loopback.port, protocol: .http)),
    id: "kb-alpha", label: "Alpha")
  let signingIn = Task {
    try await signInDevice(kb: kb, kept: MemorySignIn(), httpClient: loopback.http, clock: clock) {
      _ in
    }
  }
  return Subject(
    counted: { ledger.asked(issuerPath + "/token") }, activity: { ledger.events }, pending: { nil },
    act: nil,
    close: {
      signingIn.cancel()
      try await loopback.close()
      let unrouted = ledger.unrouted
      guard unrouted.isEmpty else {
        throw ClockCaseFailure(
          "The issuer was asked \(unrouted), which a device grant does not ask")
      }
    })
}

// ── A session ───────────────────────────────────────────────────────────

private let alphaKb = KbTarget(
  endpoint: .httpEndpoint(HttpEndpoint(host: "localhost", port: 4000, protocol: .http)),
  id: "kb-alpha", label: "Alpha")

/// A session signed in on a token issued now, by the wall clock, that lives `lifetimeSeconds`, and
/// renewed every time with a token that lives as long, issued when it renews.
private func renewal(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject {
  guard let lifetime = try givenSeconds(given, "lifetimeSeconds") else {
    throw ClockCaseFailure("A renewal's case states how long its tokens live")
  }
  let issued = Counter()
  let renewals = Counter()
  @Sendable func token() throws -> String {
    let iat = Date().timeIntervalSince1970.rounded(.down)
    return try jwt(
      .object([
        "iat": .number(iat), "exp": .number(iat + Double(lifetime)),
        "jti": .number(Double(issued.add())),
      ]))
  }
  let kept = MemorySignIn(
    HeldSignIn(
      access: try token(), clientId: scriptClientID, refresh: "a-refresh-token",
      tokenEndpoint: "http://issuer.test/realms/semiont/token"))
  let client = try await SemiontClient(
    transport: ScriptedTransport(channels: bridgedChannels, clock: clock), clock: clock)
  let session = SemiontSession(
    kb: alphaKb, client: client, kept: kept, forget: { await kept.forget() },
    renew: { _ in
      renewals.add()
      return try token()
    },
    validate: { _ in
      try UserResponse(
        did: UserId("did:web:example.org:users:alice"), domain: "example.org", email: nil,
        image: nil, name: "Alice")
    }, random: RandomSource(LowestDraw()))
  await session.start()
  return Subject(
    counted: { renewals.count }, activity: { renewals.count }, pending: { nil }, act: nil,
    close: {
      session.dispose()
      client.dispose()
    })
}

// ── A worker's claims ───────────────────────────────────────────────────

/// A worker's claims over a transport that answers `job:claim` with one job, claimed as the case
/// begins; `act` reports that job's progress.
private func heldJobStall(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject
{
  let probe = ProbeTransport(channels: jobClaimChannels)
  surfaceReplies(probe, cloneAnswer: nil)
  let client = try await SemiontClient(transport: probe, clock: clock)
  let claims = client.job.claim(
    try decoded(
      [JobFilter].self,
      .array([
        .object([
          "jobType": .string("mark"), "params": .object(["motivation": .string("highlighting")]),
        ])
      ])))
  var jobs = claims.makeAsyncIterator()
  guard let job = await jobs.next() else { throw ClockCaseFailure("No job was claimed") }
  let stalled = claims.stalled()
  let stalls = Counter()
  let reader = Task { for try await _ in stalled { stalls.add() } }
  return Subject(
    counted: { stalls.count }, activity: { stalls.count + probe.calls.count }, pending: { nil },
    act: { try await job.progress(JobProgress(percentage: 50)) },
    close: {
      reader.cancel()
      await claims.stop()
      client.dispose()
    })
}

// ── Discovery ───────────────────────────────────────────────────────────

/// A launcher's document: one managed knowledge base at the first read, unchanged at every read
/// after it.
private final class LauncherDocument: DiscoveryTransport {
  let reads = Counter()
  func read() async -> DiscoveryRead {
    guard reads.add() == 1 else { return .unchanged(Unchanged()) }
    return .state(
      .managed(
        Managed(kbs: [
          DiscoveredKB(
            did: "did:web:example.org:kb-a", host: "localhost", managedBy: "semiont-launcher",
            placement: .local, port: 4000)
        ])))
  }
}

private func discovery(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject {
  let document = LauncherDocument()
  let following = Task {
    for await _ in subscribeDiscovery(document, interval: discoveryInterval, clock: clock) {}
  }
  return Subject(
    counted: { document.reads.count }, activity: { document.reads.count }, pending: { nil },
    act: nil,
    close: { following.cancel() })
}

// ── A client's queries and caches ───────────────────────────────────────

private func requested(_ probe: ProbeTransport, _ operation: String) -> Int {
  probe.calls.filter { $0.via == "request" && $0.name == operation }.count
}

/// A client observing the `events` query of one resource, whose every request is answered; `act`
/// delivers from the wire a `mark:added` frame of that resource.
private func invalidationWindow(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let probe = ProbeTransport(channels: bridgedChannels)
  surfaceReplies(probe, cloneAnswer: nil)
  let client = try await SemiontClient(transport: probe, clock: clock)
  let resource = try ResourceId("res-1")
  let events = client.browse.events(resource)
  let observing = Task { for await _ in events {} }
  let added = Counter()
  let asked = Operations.browseEventsRequested.request.name
  return Subject(
    counted: { requested(probe, asked) }, activity: { probe.calls.count }, pending: { nil },
    act: {
      let sequence = added.add()
      let event = StoredEventResponse(
        id: "event-\(sequence)", metadata: EventMetadata(sequenceNumber: sequence), payload: [:],
        resourceId: resource, timestamp: "2026-10-01T00:00:00.000Z",
        type: Channels.markAdded.name, userId: try UserId("did:web:example.org:users:alice"),
        version: 1)
      probe.deliver(
        .frame(
          ReceivedFrame(
            channel: Channels.markAdded.name, payload: try wirePayload(event), scope: resource)))
    },
    close: {
      observing.cancel()
      client.dispose()
    })
}

/// A storage that keeps nothing, and records each save.
private final class Saves: SessionStorage {
  let saved = Counter()
  func get(_ key: String) throws -> String? { nil }
  func set(_ key: String, _ value: String) throws { saved.add() }
  func delete(_ key: String) throws {}
  func update(_ key: String, _ change: @Sendable (String?) throws -> String?) throws {
    _ = try change(nil)
    saved.add()
  }
  func subscribe(_ key: String) -> AsyncStream<String?>? { nil }
}

private func saveDebounce(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject
{
  let saves = Saves()
  let cache = Cache<String, Int>(
    persister: StoragePersister(storage: saves, storageKey: "a-cache", clock: clock), clock: clock
  ) { key in throw ClockCaseFailure("A cache that is only written fetched \(key)") }
  let changes = Counter()
  return Subject(
    counted: { saves.saved.count }, activity: { saves.saved.count + changes.count },
    pending: { nil },
    act: { await cache.set("a key", value: changes.add()) }, close: { cache.dispose() })
}

/// A client's `mark.delegate`, over a transport that answers `job:create` with a job and every
/// status request with that job running; `act` delivers from the wire a progress report of it.
private func jobFollower(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject {
  let probe = ProbeTransport(channels: bridgedChannels)
  probe.handle { operation, _ in
    switch operation {
    case Operations.jobCreate.request.name: return try jobCreatedFixture()
    case Operations.jobStatusRequested.request.name:
      return try wirePayload(JobStatusResult(response: statusFixture(status: .running)))
    default: throw SpecFailure.shape("Unscripted request: \(operation)")
    }
  }
  let client = try await SemiontClient(transport: probe, clock: clock)
  let delegation = client.mark.delegate(
    resourceId: try ResourceId("res-1"), params: try markParams())
  let following = Task { for try await _ in delegation {} }
  let asked = Operations.jobStatusRequested.request.name
  return Subject(
    counted: { requested(probe, asked) }, activity: { probe.calls.count }, pending: { nil },
    act: {
      probe.deliver(
        .frame(
          ReceivedFrame(
            channel: Channels.jobReportProgress.name,
            payload: try wirePayload(progress(percentage: 10)))))
    },
    close: {
      following.cancel()
      delegation.dispose()
      client.dispose()
    })
}

/// A client's `job.pollUntilComplete` of one job, naming no interval and no limit, set going as the
/// case begins, over a transport that answers every status request with that job running; how it
/// ended, once it has; and the task that polls.
private func polling(_ clock: TestClock) async throws -> (
  ProbeTransport, SemiontClient, Ended, Task<Void, Never>
) {
  let probe = ProbeTransport(channels: bridgedChannels)
  probe.handle { operation, _ in
    guard operation == Operations.jobStatusRequested.request.name else {
      throw SpecFailure.shape("Unscripted request: \(operation)")
    }
    return try wirePayload(JobStatusResult(response: statusFixture(status: .running)))
  }
  let client = try await SemiontClient(transport: probe, clock: clock)
  let ended = Ended()
  let asking = Task {
    do {
      _ = try await client.job.pollUntilComplete(JobId("job-1"))
      ended.tell(.answered)
    } catch let failure as BusRequestError where failure.reason == .busTimeout {
      ended.tell(.timedOut)
    } catch {
      ended.tell(.otherwise("\(error)"))
    }
  }
  return (probe, client, ended, asking)
}

private func jobPoll(_ given: [String: JSONValue], _ clock: TestClock) async throws -> Subject {
  // How the poll ends is what jobPollTimeout counts.
  let (probe, client, _, asking) = try await polling(clock)
  let asked = Operations.jobStatusRequested.request.name
  return Subject(
    counted: { requested(probe, asked) }, activity: { probe.calls.count }, pending: { nil },
    act: nil,
    close: {
      asking.cancel()
      client.dispose()
    })
}

private func jobPollTimeout(_ given: [String: JSONValue], _ clock: TestClock) async throws
  -> Subject
{
  let (probe, client, ended, asking) = try await polling(clock)
  return Subject(
    counted: { ended.value == .timedOut ? 1 : 0 },
    activity: { probe.calls.count + (ended.value == nil ? 0 : 1) }, pending: { nil }, act: nil,
    close: {
      asking.cancel()
      client.dispose()
      if case .otherwise(let failure) = ended.value {
        throw ClockCaseFailure("The poll ended otherwise: \(failure)")
      }
    })
}

private let subjects: [String: Build] = [
  "refusedStream": refusedStream,
  "unansweredStream": unansweredStream,
  "degradedStream": degradedStream,
  "scopeTaken": scopeTaken,
  "scopeLetGo": scopeLetGo,
  "handoffLinger": handoffLinger,
  "renewal": renewal,
  "deviceGrant": deviceGrant,
  "heldJobStall": heldJobStall,
  "discovery": discovery,
  "invalidationWindow": invalidationWindow,
  "saveDebounce": saveDebounce,
  "jobFollower": jobFollower,
  "unansweredRequest": unansweredRequest,
  "unansweredEmit": unansweredEmit,
  "refusedBusRequest": refusedBusRequest,
  "timedOutBusRequest": timedOutBusRequest,
  "jobPoll": jobPoll,
  "jobPollTimeout": jobPollTimeout,
]

// ── A case, played ──────────────────────────────────────────────────────

private final class Played {
  let clock: TestClock
  let start: TestClock.Instant
  let subject: Subject
  /// How far the case has moved the clock.
  private(set) var at = Duration.zero

  init(_ subject: Subject, on clock: TestClock) {
    self.subject = subject
    self.clock = clock
    start = clock.now
  }

  func settle() async throws {
    try await waitUntilStill(clock, subject.activity, pending: subject.pending)
  }

  /// Settles, then moves the clock `duration` on: to each instant a sleeper falls due on the way,
  /// in turn, letting what falls due run there.
  func pass(_ duration: Duration) async throws {
    try await settle()
    at += duration
    let until = start.advanced(by: at)
    while let wake = clock.wakes.first, wake <= until {
      clock.advance(by: clock.now.duration(to: wake))
      try await settle()
    }
    if clock.now < until {
      clock.advance(by: clock.now.duration(to: until))
      try await settle()
    }
  }

  func perform(_ step: JSONValue) async throws {
    if step == .string("settle") { return try await settle() }
    if step == .string("act") {
      guard let act = subject.act else { throw ClockCaseFailure("The subject has no action") }
      try await withinTestDeadline(act)
      return try await settle()
    }
    let stated = try step.object
    if let duration = stated["pass"] { return try await pass(stateCaseDuration(duration)) }
    if let expected = stated["counted"] {
      try await settle()
      let counted = subject.counted()
      guard counted == (try stateCaseInteger(expected)) else {
        throw ClockCaseFailure("counted \(counted), not \(try stateCaseInteger(expected))")
      }
      return
    }
    throw ClockCaseFailure("No step this runner performs")
  }
}

private func play(_ row: [String: JSONValue]) async throws {
  let name = try required(row, "subject").text
  guard let build = subjects[name] else { throw ClockCaseFailure("No subject \(name)") }
  let given: [String: JSONValue]
  if let stated = row["given"] { given = try stated.object } else { given = [:] }
  let clock = TestClock()
  let subject = try await withinTestDeadline { try await build(given, clock) }
  let played = Played(subject, on: clock)
  do {
    for (index, step) in try required(row, "steps").array.enumerated() {
      do { try await played.perform(step) } catch let failure as ClockCaseFailure {
        throw ClockCaseFailure("steps[\(index)] \(step), at \(played.at): \(failure)")
      }
    }
  } catch {
    try await subject.close()
    throw error
  }
  try await subject.close()
}

// ── The tests ───────────────────────────────────────────────────────────

@Test func clockCasesNameNoSubjectThisRunnerDoesNotBuild() throws {
  let named = Set(try clockCases().map { try required($0, "subject").text })
  #expect(Set(subjects.keys) == named)
}

@Test func everyClockCaseEndsEachWaitWhenItSays() async throws {
  for row in try clockCases() {
    let named = "\(try required(row, "subject").text): \(try required(row, "case").text)"
    do { try await play(row) } catch { Issue.record("\(named): \(error)") }
  }
}

@Test func theClockRunnerFailsACaseWhoseWaitEndsAMillisecondEarly() async throws {
  var told = try #require(
    clockCases().first { try required($0, "subject").text == "refusedStream" })
  var steps = try required(told, "steps").array
  // The last millisecond of the first wait: the case is told the stream was opened again in it.
  #expect(steps[2] == .object(["counted": .number(1)]))
  steps[2] = .object(["counted": .number(2)])
  told["steps"] = .array(steps)
  do {
    try await play(told)
    Issue.record("A stream said to open a millisecond early passed")
  } catch let failure as ClockCaseFailure {
    #expect(failure.description.hasPrefix("steps[2]"))
  }
}
