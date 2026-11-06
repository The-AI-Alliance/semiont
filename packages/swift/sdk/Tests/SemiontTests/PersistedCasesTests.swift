import AsyncHTTPClient
import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
@testable import SemiontTesting
import Synchronization
import Testing

@testable import Semiont

// What a client keeps of one person, against protocol/specs/src/session/persisted-cases.json: the
// keys it keeps them under (`keys`), what forgetting a stored sign-in deletes, however it is
// forgotten (`forget`), what a session of a registry reads, records and restores from its start
// (`startup`), what it still writes once another context changes its stored sign-in (`crossTab`),
// and once what holds its sign-in in this process changes it (`holder`). The sessions of
// `forget`'s expiry and refusal, of `startup` and of `crossTab` are the registry's own, made by
// HttpSessionFactory over a gateway and an issuer in this process; `holder`'s is a script's, made
// by sessionFromKept over a MemorySignIn. Last, a save being written when its session forgets its
// sign-in lands before the forget deletes, never after.

private func casesTable() throws -> [String: JSONValue] {
  try Spec.read("session/persisted-cases.json").object
}

private func optionalText(_ value: JSONValue) throws -> String? {
  guard value != .null else { return nil }
  return try value.text
}

/// The key the person `name` of the table's `people` makes.
private func personKeyOf(_ table: [String: JSONValue], _ name: String) throws -> String {
  try required(required(required(table, "people").object, name).object, "personKey").text
}

/// The keys the table's `keys` part states for a person on a knowledge base.
private struct PersonKeys {
  let stream: String
  /// Each persisted query's key, by the query's name.
  let queries: [String: String]
  var all: Set<String> { Set([stream] + queries.values) }

  func query(_ name: String) throws -> String {
    guard let key = queries[name] else { throw SpecFailure.shape("no key of the query \(name)") }
    return key
  }
}

private func keysOf(_ table: [String: JSONValue], kbId: String, personKey: String) throws
  -> PersonKeys
{
  for value in try required(table, "keys").array {
    let row = try value.object
    guard try required(row, "kbId").text == kbId, try required(row, "personKey").text == personKey
    else { continue }
    return PersonKeys(
      stream: try required(row, "lastEventIdKey").text,
      queries: try required(row, "cacheKeys").object.mapValues { try $0.text })
  }
  throw SpecFailure.shape("The keys part states no row of \(personKey) on \(kbId)")
}

/// The person kb-a's stored sign-in names as a row's `signedIn` says: jo for `named`, nobody for
/// `unnamed`.
private func namedIn(_ row: [String: JSONValue], jo: String) throws -> String? {
  switch try required(row, "signedIn").text {
  case "named": return jo
  case "unnamed": return nil
  case let other: throw SpecFailure.shape("signedIn \(other)")
  }
}

/// The issuer of a sign-in that is never renewed: nothing is asked there.
private let unaskedIssuer = "http://issuer.test/token"

/// An access token of `tokens` that expired an hour ago when `expired`, and expires in an hour
/// otherwise.
private func accessToken(_ tokens: String, expired: Bool) throws -> String {
  try jwt(
    .object([
      "exp": .number(Date().timeIntervalSince1970 + (expired ? -3600 : 3600)),
      "name": .string(tokens),
    ]))
}

/// A sign-in naming `personKey`, whose tokens are `tokens`' and are renewed at `tokenEndpoint`.
private func signIn(
  personKey: String?, tokens: String = "kept", expired: Bool, tokenEndpoint: String
) throws -> HeldSignIn {
  HeldSignIn(
    access: try accessToken(tokens, expired: expired), clientId: scriptClientID,
    personKey: personKey,
    refresh: tokens + "-refresh", tokenEndpoint: tokenEndpoint)
}

private let kbDomain = "kb.example.org"

private func knowledgeBase(_ id: String, port: Int) -> KnowledgeBase {
  KnowledgeBase(
    did: "did:web:" + kbDomain,
    endpoint: .httpEndpoint(HttpEndpoint(host: "127.0.0.1", port: port, protocol: .http)), id: id,
    label: id)
}

private func resource(_ id: ResourceId, named name: String) throws -> ResourceDescriptor {
  try decoded(
    ResourceDescriptor.self,
    .object([
      "@context": .string("https://schema.org/"), "@id": .string(id.value), "name": .string(name),
      "representations": .array([]),
    ]))
}

/// What the stored document `text` keeps for `key`, the document being as every SDK writes it:
/// `{"version": 1, "writtenAt": …, "entries": [[key, value, writtenAt], …]}`.
private func keptValue(_ text: String?, key: JSONValue) throws -> JSONValue? {
  guard let text else { return nil }
  let document = try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)).object
  guard try required(document, "version") == .number(1) else {
    throw SpecFailure.shape("a stored document of another version: \(text)")
  }
  for entry in try required(document, "entries").array {
    let parts = try entry.array
    guard parts.count == 3, case .number = parts[2] else {
      throw SpecFailure.shape("an entry that is not [key, value, writtenAt]: \(text)")
    }
    if parts[0] == key { return parts[1] }
  }
  return nil
}

/// A cached query observed from now until `stop`, its resource held all the while.
private final class Observed<Value: Sendable>: Sendable {
  private let states: AsyncStream<CacheState<Value>>
  private let reader: Task<Void, Never>

  init(_ query: Cached<Value>) {
    let (states, into) = AsyncStream<CacheState<Value>>.makeStream()
    self.states = states
    reader = Task {
      for await state in query { into.yield(state) }
      into.finish()
    }
  }

  /// The first value the query gives. Called once.
  func first() async throws -> Value {
    for await state in states {
      switch state {
      case .pending: continue
      case .ready(let value): return value
      case .failed(let error): throw error
      }
    }
    throw SpecFailure.shape("The query ended without a value")
  }

  func stop() { reader.cancel() }
}

// ── keys ────────────────────────────────────────────────────────────────

@Test func everyKeyOfAPersonIsTheCaseTables() throws {
  let table = try casesTable()
  let persisted = try required(Spec.read("client/refresh.json").object, "queries").array
    .compactMap { value -> String? in
      let query = try value.object
      guard query["persisted"] == .bool(true) else { return nil }
      return try required(query, "name").text
    }
  #expect(KeptQuery.allCases.map(\.rawValue) == persisted)
  for (name, value) in try required(table, "people").object {
    let person = try value.object
    let did = try UserId(required(person, "did").text)
    #expect(personKey(did) == (try required(person, "personKey").text), "\(name)")
  }
  for value in try required(table, "keys").array {
    let row = try value.object
    let why = try required(row, "why").text
    let kbId = try required(row, "kbId").text
    let key = personKey(try UserId(required(row, "did").text))
    #expect(key == (try required(row, "personKey").text), "\(why)")
    #expect(lastEventIdKey(kbId, key) == (try required(row, "lastEventIdKey").text), "\(why)")
    let cacheKeys = try required(row, "cacheKeys").object.mapValues { try $0.text }
    #expect(Set(cacheKeys.keys) == Set(persisted), "\(why)")
    for query in KeptQuery.allCases {
      #expect(cacheKey(kbId, key, query) == cacheKeys[query.rawValue], "\(why): \(query.rawValue)")
    }
  }
}

// ── forget ──────────────────────────────────────────────────────────────

/// A registry's sessions whose closing writes `document` under `key`, as a client kept for the
/// person `person` closing with a save pending could. A session is kept for them only when its
/// knowledge base's stored sign-in names them as it opens.
private final class ClosingWrites: SessionFactory {
  private let scripted = ScriptedSessions { _, channel, _ in
    guard channel == Channels.browseKbRequested.name else {
      throw BusRequestError(.busNotFound, "\(channel) is not scripted")
    }
    return try wirePayload(BrowseKbResult(response: KbDescription(domain: kbDomain, name: "KB")))
  }
  private let storage: MemorySessionStorage
  private let person: String
  private let key: String
  private let document: String
  private let closed = Mutex(0)

  init(storage: MemorySessionStorage, person: String, key: String, document: String) {
    self.storage = storage
    self.person = person
    self.key = key
    self.document = document
  }

  /// How many sessions kept for the person have closed.
  var closings: Int { closed.withLock { $0 } }

  func session(_ options: SessionFactoryOptions) async throws -> OpenedSession {
    let keptFor = try storedSession(options.storage, kbId: options.kb.id)?.personKey
    let opened = try await scripted.session(options)
    guard keptFor == person else { return opened }
    opened.session.lifetime.onEnd { [self] in
      storage.set(key, document)
      closed.withLock { $0 += 1 }
    }
    return opened
  }

  func revoke(_ session: HeldSignIn) async { await scripted.revoke(session) }
}

@Test func forgettingAStoredSignInDeletesWhatTheCaseTableSays() async throws {
  let table = try casesTable()
  let seeded = try required(table, "forgetStorage").object.mapValues { try $0.text }
  let jo = try personKeyOf(table, "jo")
  let joOnA = try keysOf(table, kbId: "kb-a", personKey: jo)
  let user = try JSONEncoder().encode(required(table, "whoAmI"))
  let closingAt = JSONValue.number(1_700_000_000_001)
  let closingValue = try encoded(resource(ResourceId("res-1"), named: "closing"))
  let closing = try JSONEncoder().encode(
    JSONValue.object([
      "version": .number(1), "writtenAt": closingAt,
      "entries": .array([.array([.string("res-1"), closingValue, closingAt])]),
    ]))
  let closingDocument = String(decoding: closing, as: UTF8.self)
  let closingKey = try joOnA.query("resource")
  for value in try required(table, "forget").array {
    let row = try value.object
    let why = try required(row, "why").text
    let by = try required(row, "by").text
    let open = try required(row, "open") == .bool(true)
    let removed: Set<String>
    switch try required(row, "removes").text {
    case "person": removed = joOnA.all
    case "nothing": removed = []
    case let other: throw SpecFailure.shape("removes \(other)")
    }
    // Whether kb-a has a stored sign-in, and the person it names.
    let stored = try required(row, "signedIn") != .string("none")
    let named = try stored ? namedIn(row, jo: jo) : nil
    let storage = MemorySessionStorage()
    for (key, text) in seeded { storage.set(key, text) }
    switch by {
    case "signOut", "removal", "signIn":
      try saveKnowledgeBases(
        storage,
        knowledgeBases: [knowledgeBase("kb-a", port: 4000), knowledgeBase("kb-b", port: 4001)])
      storage.set(activeKey, open ? "kb-a" : "kb-b")
      if stored {
        try storeSession(
          storage, kbId: "kb-a",
          session: signIn(personKey: named, expired: false, tokenEndpoint: unaskedIssuer))
      }
      let factory = ClosingWrites(
        storage: storage, person: jo, key: closingKey, document: closingDocument)
      let browser = try await newSemiontBrowser(
        SemiontBrowserConfig(storage: storage, sessionFactory: factory))
      // A `signIn` row's new sign-in, which names nobody until its gateway names them.
      let replacing = try signIn(
        personKey: nil, tokens: "new", expired: false, tokenEndpoint: unaskedIssuer)
      do {
        if open {
          try await withinTestDeadline {
            for await opened in browser.activeSession where opened?.session.kb.id == "kb-a" {
              break
            }
          }
        }
        switch by {
        case "signOut": try await browser.signOut("kb-a")
        case "removal": try await browser.removeKb("kb-a")
        case "signIn":
          try await browser.signIn("kb-a", session: replacing)
          let now = try storedSession(storage, kbId: "kb-a")
          #expect(now?.access == replacing.access, "\(why): the new sign-in is kb-a's")
          #expect(now?.personKey == nil, "\(why): the new sign-in names nobody")
        case let other: throw SpecFailure.shape("by \(other)")
        }
        #expect(factory.closings == (open ? 1 : 0), "\(why): kb-a's client closed")
      } catch {
        try? await browser.close()
        throw error
      }
      try await browser.close()
    case "expiry", "refusal":
      guard open else { throw SpecFailure.shape("\(why): a session that ends is kb-a's open one") }
      let expired: Bool
      switch try required(row, "stored").text {
      case "expired": expired = true
      case "unexpired": expired = false
      case let other: throw SpecFailure.shape("stored \(other)")
      }
      let issuer: Issuer =
        try by == "refusal" ? .renews(access: accessToken("renewed", expired: false)) : .refuses
      try await overGateway(.refuses, issuer: issuer, user: user) { _, port, http in
        if stored {
          try storeSession(
            storage, kbId: "kb-a",
            session: signIn(
              personKey: named, expired: expired, tokenEndpoint: "http://127.0.0.1:\(port)/token"))
        }
        let (failures, into) = AsyncStream<any Error>.makeStream()
        let opened = try await HttpSessionFactory(httpClient: http).session(
          SessionFactoryOptions(
            kb: knowledgeBase("kb-a", port: port), storage: storage, signals: SessionSignals(),
            onError: { into.yield($0) }))
        defer { opened.dispose() }
        // Its start ends as the row says: it is ready once it has forgotten the stored sign-in.
        try await withinTestDeadline { try await opened.session.ready() }
        opened.dispose()
        into.finish()
        var ended: [SessionErrorCode] = []
        for await failure in failures {
          if let failure = failure as? SessionError { ended.append(failure.reason) }
        }
        #expect(try storedSession(storage, kbId: "kb-a") == nil, "\(why): the sign-in is kept")
        if by == "refusal" {
          #expect(ended.contains(.sessionCredentialRefused), "\(why): it ended \(ended)")
        }
      }
    case let other: throw SpecFailure.shape("by \(other)")
    }
    for key in removed { #expect(storage.get(key) == nil, "\(why): \(key) is left") }
    for (key, text) in seeded where !removed.contains(key) {
      #expect(storage.get(key) == text, "\(why): \(key) changed")
    }
  }
}

// ── The gateway and issuer of `forget`, `startup` and `crossTab` ────────

/// What the gateway says to whoever asks who a token is.
private enum WhoAmI: Sendable {
  /// It names the person at once.
  case names
  /// It names the person once `answerWhoAmI()` is called.
  case holds
  /// It answers that it cannot say.
  case unavailable
  /// It refuses the token.
  case refuses
}

/// What the issuer, at the gateway's `/token`, says to a refresh grant.
private enum Issuer: Sendable {
  /// It is never asked.
  case unasked
  /// It refuses the grant.
  case refuses
  /// It issues the access token `access`.
  case renews(access: String)
}

/// What the gateway writes on a connection.
private enum Answer: Sendable {
  case json(Int, Data)
  case streamOpened
  case streamEvent(String)

  func write(to context: ChannelHandlerContext) {
    switch self {
    case .json(let status, let body):
      let head = HTTPResponseHead(
        version: .http1_1, status: HTTPResponseStatus(statusCode: status),
        headers: HTTPHeaders([
          ("Content-Type", "application/json"), ("Content-Length", String(body.count)),
        ]))
      context.write(NIOAny(HTTPServerResponsePart.head(head)), promise: nil)
      context.write(
        NIOAny(HTTPServerResponsePart.body(.byteBuffer(ByteBuffer(bytes: body)))), promise: nil)
      context.writeAndFlush(NIOAny(HTTPServerResponsePart.end(nil)), promise: nil)
    case .streamOpened:
      // A length no stream reaches keeps it open with nothing more to frame.
      let head = HTTPResponseHead(
        version: .http1_1, status: .ok,
        headers: HTTPHeaders([
          ("Content-Type", "text/event-stream"), ("Content-Length", "100000000"),
        ]))
      context.writeAndFlush(NIOAny(HTTPServerResponsePart.head(head)), promise: nil)
    case .streamEvent(let text):
      context.writeAndFlush(
        NIOAny(HTTPServerResponsePart.body(.byteBuffer(ByteBuffer(string: text)))), promise: nil)
    }
  }
}

/// A gateway in this process. It holds open every stream a client opens and remembers what each
/// subscribes to; it answers a read of a resource with that resource named `fresh` and a read of
/// the knowledge base with kb.example.org, on the stream opened last; it answers who a token is as
/// `WhoAmI` says, naming `user`; and it answers a refresh grant at `/token` as `Issuer` says.
private final class PersonGateway: Sendable {
  private struct State: Sendable {
    var whoAmI: WhoAmI
    var waiting: [@Sendable (Answer) -> Void] = []
    var streams: [@Sendable (Answer) -> Void] = []
    var subscriptions: [BusSubscribeRequest] = []
    var faults: [String] = []
  }
  private let state: Mutex<State>
  private let issuer: Issuer
  private let user: Data

  init(whoAmI: WhoAmI, issuer: Issuer, user: Data) {
    state = Mutex(State(whoAmI: whoAmI))
    self.issuer = issuer
    self.user = user
  }

  /// What the gateway was asked that it could not answer.
  var faults: [String] { state.withLock { $0.faults } }

  private func fault(_ what: String) { state.withLock { $0.faults.append(what) } }

  func asked(_ path: String, body: Data, respond: @escaping @Sendable (Answer) -> Void) {
    switch path {
    case "/bus/subscribe":
      do {
        let subscription = try JSONDecoder().decode(BusSubscribeRequest.self, from: body)
        state.withLock { state in
          state.subscriptions.append(subscription)
          state.streams.append(respond)
        }
        respond(.streamOpened)
      } catch {
        fault("an unreadable subscription: \(error)")
        respond(.json(400, Data()))
      }
    case "/bus/emit":
      do {
        let emitted = try JSONDecoder().decode(BusEmitRequest.self, from: body)
        let accepted = try JSONEncoder().encode(BusEmitAccepted(subscribers: 1))
        respond(.json(200, accepted))
        guard let event = try reply(to: emitted) else { return }
        guard let stream = state.withLock({ $0.streams.last }) else {
          fault("\(emitted.channel) with no stream open to answer on")
          return
        }
        stream(.streamEvent(event))
      } catch {
        fault("an unreadable emit: \(error)")
        respond(.json(400, Data()))
      }
    case "/api/users/me":
      let answer: Answer? = state.withLock { state in
        switch state.whoAmI {
        case .names: return .json(200, user)
        case .unavailable: return .json(503, Data(#"{"error":"The gateway cannot say"}"#.utf8))
        case .refuses: return .json(401, Data(#"{"error":"The token is refused"}"#.utf8))
        case .holds:
          state.waiting.append(respond)
          return nil
        }
      }
      if let answer { respond(answer) }
    case "/token":
      switch issuer {
      case .unasked:
        fault("asked the issuer")
        respond(.json(404, Data(#"{"error":"No issuer"}"#.utf8)))
      case .refuses: respond(.json(400, Data(#"{"error":"invalid_grant"}"#.utf8)))
      case .renews(let access):
        do {
          let issued = try JSONEncoder().encode(
            JSONValue.object([
              "access_token": .string(access), "refresh_token": .string("renewed-refresh"),
              "token_type": .string("Bearer"),
            ]))
          respond(.json(200, issued))
        } catch {
          fault("an unwritable grant: \(error)")
          respond(.json(500, Data()))
        }
      }
    default:
      fault("asked \(path)")
      respond(.json(404, Data(#"{"error":"No route"}"#.utf8)))
    }
  }

  private func reply(to emitted: BusEmitRequest) throws -> String? {
    let frame: BusFrame
    switch emitted.channel {
    case Channels.browseResourceRequested.name:
      let read = try decoded(BrowseResourceRequest.self, .object(emitted.payload))
      frame = BusFrame(
        channel: Channels.browseResourceResult.name, correlationId: emitted.correlationId,
        payload: try wirePayload(
          BrowseResourceResult(
            response: BrowseResourceResultResponse(
              lastSequence: 0, resource: try resource(read.resourceId, named: "fresh")))))
    case Channels.browseKbRequested.name:
      frame = BusFrame(
        channel: Channels.browseKbResult.name, correlationId: emitted.correlationId,
        payload: try wirePayload(
          BrowseKbResult(response: KbDescription(domain: kbDomain, name: "KB"))))
    default: return nil
    }
    let data = try JSONEncoder().encode(frame)
    return "event: bus-event\ndata: " + String(decoding: data, as: UTF8.self) + "\n\n"
  }

  /// Names the person to whoever waits to be told, and to whoever asks from now on.
  func answerWhoAmI() {
    let waiting: [@Sendable (Answer) -> Void] = state.withLock { state in
      guard state.whoAmI == .holds else { return [] }
      state.whoAmI = .names
      let waiting = state.waiting
      state.waiting.removeAll()
      return waiting
    }
    for respond in waiting { respond(.json(200, user)) }
  }

  /// Where the first subscription naming `scope` resumes it from: nil while none names it, and
  /// `.some(nil)` when the one that does resumes it from nowhere.
  func place(of scope: ResourceId) -> String?? {
    state.withLock { state in
      for subscription in state.subscriptions {
        if let entry = subscription.scoped?.first(where: { $0.scope == scope }) {
          return .some(entry.lastEventId)
        }
      }
      return nil
    }
  }

  /// Where the first subscription naming `scope` resumes it from, once one names it.
  func awaitPlace(of scope: ResourceId) async throws -> String? {
    try await withinTestDeadline { () async throws -> String? in
      while true {
        if let found = self.place(of: scope) { return found }
        try await Task.sleep(for: .milliseconds(2))
      }
    }
  }
}

private final class PersonGatewayHandler: ChannelInboundHandler {
  typealias InboundIn = HTTPServerRequestPart
  typealias OutboundOut = HTTPServerResponsePart
  private let gateway: PersonGateway
  private var head: HTTPRequestHead?
  private var body = Data()

  init(_ gateway: PersonGateway) { self.gateway = gateway }

  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    switch unwrapInboundIn(data) {
    case .head(let head):
      self.head = head
      body = Data()
    case .body(let chunk): body.append(contentsOf: chunk.readableBytesView)
    case .end:
      guard let head else { return }
      let loop = context.eventLoop
      let bound = NIOLoopBound(context, eventLoop: loop)
      gateway.asked(String(head.uri.prefix { $0 != "?" }), body: body) { answer in
        loop.execute { answer.write(to: bound.value) }
      }
    }
  }
}

/// `run` with a client of a gateway in this process that answers who a token is as `whoAmI` says,
/// and a refresh grant as `issuer` says.
private func overGateway(
  _ whoAmI: WhoAmI, issuer: Issuer, user: Data,
  _ run: @Sendable (PersonGateway, _ port: Int, HTTPClient) async throws -> Void
) async throws {
  let gateway = PersonGateway(whoAmI: whoAmI, issuer: issuer, user: user)
  let server = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
    .childChannelInitializer { channel in
      channel.eventLoop.makeCompletedFuture {
        try channel.pipeline.syncOperations.configureHTTPServerPipeline(
          withPipeliningAssistance: false)
        try channel.pipeline.syncOperations.addHandler(PersonGatewayHandler(gateway))
      }
    }.bind(host: "127.0.0.1", port: 0).get()
  let http = HTTPClient(eventLoopGroupProvider: .singleton)
  do {
    let port = try #require(server.localAddress?.port)
    try await run(gateway, port, http)
  } catch {
    try? await http.shutdown()
    try? await server.close().get()
    throw error
  }
  try await http.shutdown()
  try await server.close().get()
  #expect(gateway.faults.isEmpty, "\(gateway.faults)")
}

// ── startup ─────────────────────────────────────────────────────────────

@Test func aRegistrysSessionKeepsWhatTheCaseTableSaysFromItsStart() async throws {
  let table = try casesTable()
  let stored = try Spec.read("session/stored.json").object
  let prefixes = try ["cacheKeyPrefix", "lastEventIdKeyPrefix"].map {
    try required(required(stored, $0).object, "prefix").text
  }
  let seeded = try required(table, "startupStorage").object.mapValues { try $0.text }
  let jo = try personKeyOf(table, "jo")
  let keptResources = try keysOf(table, kbId: "kb-a", personKey: jo).query("resource")
  let user = try JSONEncoder().encode(required(table, "whoAmI"))
  let askedFirst = try ResourceId("res-2")
  let askedThen = try ResourceId("res-1")
  /// The name of what a row says the client gives for `id`.
  func given(_ value: JSONValue, _ id: ResourceId) throws -> String {
    switch try value.text {
    case "kept":
      let kept = try keptValue(seeded[keptResources], key: .string(id.value))
      guard case .string(let name)? = try kept?.object["name"] else {
        throw SpecFailure.shape("startupStorage keeps no \(id.value)")
      }
      return name
    case "fresh": return "fresh"
    case let other: throw SpecFailure.shape("a client gives \(other)")
    }
  }
  for value in try required(table, "startup").array {
    let row = try value.object
    let why = try required(row, "why").text
    let whoAmI: WhoAmI
    switch try required(row, "gateway").text {
    case "names": whoAmI = .holds
    case "unreachable": whoAmI = .unavailable
    case let other: throw SpecFailure.shape("gateway \(other)")
    }
    let first = try given(required(row, "first"), askedFirst)
    let then = try given(required(row, "then"), askedThen)
    let recorded = try optionalText(required(row, "recorded"))
    let place = try optionalText(required(row, "place"))
    let untouched = row["untouched"] == .bool(true)
    let storage = ListedStorage()
    for (key, text) in seeded { storage.set(key, text) }
    try storeSession(
      storage, kbId: "kb-a",
      session: signIn(
        personKey: namedIn(row, jo: jo), expired: false, tokenEndpoint: unaskedIssuer))
    try await overGateway(whoAmI, issuer: .unasked, user: user) { gateway, port, http in
      let opened = try await HttpSessionFactory(httpClient: http).session(
        SessionFactoryOptions(
          kb: knowledgeBase("kb-a", port: port), storage: storage, signals: SessionSignals(),
          onError: { _ in }))
      defer { opened.dispose() }
      let early = Observed(opened.client.browse.resource(askedFirst))
      defer { early.stop() }
      let givenFirst = try await withinTestDeadline { try await early.first() }
      #expect(givenFirst.name == first, "\(why)")
      gateway.answerWhoAmI()
      try await withinTestDeadline { try await opened.session.ready() }
      let signedIn = try storedSession(storage, kbId: "kb-a")
      #expect(signedIn?.personKey == recorded, "\(why)")
      let late = Observed(opened.client.browse.resource(askedThen))
      defer { late.stop() }
      let givenThen = try await withinTestDeadline { try await late.first() }
      #expect(givenThen.name == then, "\(why)")
      #expect(try await gateway.awaitPlace(of: askedThen) == place, "\(why)")
      guard untouched else { return }
      late.stop()
      early.stop()
      opened.dispose()
      let held = storage.held
      for (key, text) in seeded { #expect(held[key] == text, "\(why): \(key) changed") }
      for key in held.keys where prefixes.contains(where: { key.hasPrefix($0) }) {
        #expect(seeded[key] != nil, "\(why): \(key) written")
      }
    }
  }
}

/// A storage in this process that can say every key it holds.
private final class ListedStorage: SessionStorage {
  private let values = Mutex<[String: String]>([:])

  var held: [String: String] { values.withLock { $0 } }

  func get(_ key: String) -> String? { values.withLock { $0[key] } }
  func set(_ key: String, _ value: String) { values.withLock { $0[key] = value } }
  func delete(_ key: String) { values.withLock { $0[key] = nil } }
  func update(_ key: String, _ change: @Sendable (String?) throws -> String?) throws {
    try values.withLock { values in
      let value = try change(values[key])
      values[key] = value
    }
  }
  func subscribe(_ key: String) -> AsyncStream<String?>? { nil }
}

// ── crossTab ────────────────────────────────────────────────────────────

@Test func aRegistrysSessionWritesNothingOnceItsStoredSignInIsNotItsPersons() async throws {
  let table = try casesTable()
  let jo = try personKeyOf(table, "jo")
  let resourceKey = try keysOf(table, kbId: "kb-a", personKey: jo).query("resource")
  let user = try JSONEncoder().encode(required(table, "whoAmI"))
  let asked = try ResourceId("res-1")
  for value in try required(table, "crossTab").array {
    let row = try value.object
    let why = try required(row, "why").text
    let saved = try required(row, "saved") == .bool(true)
    let replacement: HeldSignIn?
    switch try required(row, "stored") {
    case .null: replacement = nil
    case .object(let stored):
      replacement = try signIn(
        personKey: optionalText(required(stored, "personKey")), tokens: "another",
        expired: false, tokenEndpoint: unaskedIssuer)
    default: throw SpecFailure.shape("\(why): stored is a sign-in or null")
    }
    try await overGateway(.names, issuer: .unasked, user: user) { _, port, http in
      let storage = SharedStorage()
      try saveKnowledgeBases(storage, knowledgeBases: [knowledgeBase("kb-a", port: port)])
      storage.set(activeKey, "kb-a")
      try storeSession(
        storage, kbId: "kb-a",
        session: signIn(personKey: jo, expired: false, tokenEndpoint: unaskedIssuer))
      // On a clock that never moves, every save waits for the client's close.
      let browser = try await newSemiontBrowser(
        SemiontBrowserConfig(
          storage: storage,
          sessionFactory: HttpSessionFactory(httpClient: http, clock: TestClock())))
      do {
        let opened = try await withinTestDeadline { () async throws -> OpenedSession in
          for await opened in browser.activeSession {
            if let opened { return opened }
          }
          throw SpecFailure.shape("kb-a's session never opened")
        }
        let observed = Observed(opened.client.browse.resource(asked))
        let held = try await withinTestDeadline { try await observed.first() }
        observed.stop()
        #expect(held.name == "fresh", "\(why)")
        #expect(storage.get(resourceKey) == nil, "\(why): written before the client closed")
        let other = storage.context()
        if let replacement {
          try storeSession(other, kbId: "kb-a", session: replacement)
        } else {
          try clearStoredSession(other, kbId: "kb-a")
        }
      } catch {
        try? await browser.close()
        throw error
      }
      try await browser.close()
      let kept = try keptValue(storage.get(resourceKey), key: .string(asked.value))
      let keptName = try kept?.object["name"]
      #expect((keptName == .string("fresh")) == saved, "\(why)")
    }
  }
}

// ── holder ──────────────────────────────────────────────────────────────

/// How a `holder` row changes the sign-in, through the memory sign-in that holds it.
private enum HolderChange: Sendable {
  case forget
  /// A new sign-in kept in its place, naming the person whose key this is, or nobody.
  case keep(personKey: String?)
  /// The same sign-in with other tokens.
  case renew
}

@Test func aScriptSessionWritesNothingOnceWhatHoldsItsSignInNoLongerNamesItsPerson() async throws {
  let table = try casesTable()
  let jo = try personKeyOf(table, "jo")
  let resourceKey = try keysOf(table, kbId: "kb-a", personKey: jo).query("resource")
  let user = try JSONEncoder().encode(required(table, "whoAmI"))
  let asked = try ResourceId("res-1")
  for value in try required(table, "holder").array {
    let row = try value.object
    let why = try required(row, "why").text
    let saved = try required(row, "saved") == .bool(true)
    let change: HolderChange
    switch try required(row, "stored") {
    case .null: change = .forget
    case .object(let stored):
      let named = try optionalText(required(stored, "personKey"))
      change = named == jo ? .renew : .keep(personKey: named)
    default: throw SpecFailure.shape("\(why): stored is a sign-in or null")
    }
    try await overGateway(.names, issuer: .unasked, user: user) { _, port, http in
      let memory = try MemorySignIn(
        signIn(personKey: jo, expired: false, tokenEndpoint: unaskedIssuer))
      let caches = MemorySessionStorage()
      let kb = knowledgeBase("kb-a", port: port)
      // On a clock that never moves, every save waits for the client's close.
      let opened = try await sessionFromKept(
        kb: KbTarget(endpoint: kb.endpoint, id: kb.id, label: kb.label), kept: memory,
        httpClient: http, onError: { _ in }, storage: caches, clock: TestClock())
      defer { opened.dispose() }
      try await withinTestDeadline { try await opened.session.ready() }
      let observed = Observed(opened.client.browse.resource(asked))
      let held = try await withinTestDeadline { try await observed.first() }
      observed.stop()
      #expect(held.name == "fresh", "\(why)")
      #expect(caches.get(resourceKey) == nil, "\(why): written before the client closed")
      switch change {
      case .forget: await memory.forget()
      case .keep(let personKey):
        try await memory.keep(
          signIn(
            personKey: personKey, tokens: "another", expired: false, tokenEndpoint: unaskedIssuer))
      case .renew:
        let read = try #require(await memory.held())
        let access = try accessToken("another", expired: false)
        #expect(
          await memory.renewed(read: read, access: access, refresh: "another-refresh") == access,
          "\(why): renewed")
      }
      opened.dispose()
      let kept = try keptValue(caches.get(resourceKey), key: .string(asked.value))
      let keptName = try kept?.object["name"]
      #expect((keptName == .string("fresh")) == saved, "\(why)")
    }
  }
}

// ── A save being written when its session forgets its sign-in ───────────

/// How long a held write waits, once a forget has begun, for that forget to delete what it is
/// writing. A forget that deletes while a write is in flight does so at once; one that waits for
/// the write never does, and the write goes on when this has passed.
private let deleteAllowance = Duration.seconds(1)

/// A storage in this process whose next write of `key`, once held, waits until `began` says a
/// forget has begun, and then until that forget deletes `key` or `deleteAllowance` has passed. It
/// waits on the thread that writes, so nothing else needs to run for it to go on.
private final class HoldingStorage: SessionStorage {
  private struct State: Sendable {
    var values: [String: String] = [:]
    var began: (@Sendable () -> Bool)?
    var holding = false
    var deletedWhileHeld = false
    var written = false
    var neverBegan = false
  }
  private let key: String
  private let state = Mutex(State())

  init(key: String) { self.key = key }

  /// Holds the next write of the key until `began` holds.
  func hold(until began: @escaping @Sendable () -> Bool) { state.withLock { $0.began = began } }

  /// Whether the held write is waiting.
  var holding: Bool { state.withLock { $0.holding } }
  /// Whether the held write has been made.
  var written: Bool { state.withLock { $0.written } }
  /// Whether the key was deleted while its held write waited.
  var deletedWhileHeld: Bool { state.withLock { $0.deletedWhileHeld } }
  /// Whether the held write went on because no forget began within the test's deadline.
  var neverBegan: Bool { state.withLock { $0.neverBegan } }

  func get(_ key: String) -> String? { state.withLock { $0.values[key] } }
  func set(_ key: String, _ value: String) { write(key) { _ in value } }
  func update(_ key: String, _ change: @Sendable (String?) throws -> String?) rethrows {
    try write(key, change)
  }
  func delete(_ key: String) {
    state.withLock { state in
      state.values[key] = nil
      if key == self.key, state.holding { state.deletedWhileHeld = true }
    }
  }
  func subscribe(_ key: String) -> AsyncStream<String?>? { nil }

  private func write(_ key: String, _ change: (String?) throws -> String?) rethrows {
    let began = state.withLock { state -> (@Sendable () -> Bool)? in
      guard key == self.key, let began = state.began else { return nil }
      state.began = nil
      state.holding = true
      return began
    }
    if let began { wait(began) }
    try state.withLock { state in
      state.values[key] = try change(state.values[key])
      guard began != nil else { return }
      state.holding = false
      state.written = true
    }
  }

  private func wait(_ began: @Sendable () -> Bool) {
    let clock = ContinuousClock()
    let deadline = clock.now + .milliseconds(testDeadlineMs)
    while !began() {
      guard clock.now < deadline else {
        state.withLock { $0.neverBegan = true }
        return
      }
      Thread.sleep(forTimeInterval: 0.001)
    }
    let allowed = clock.now + deleteAllowance
    while !deletedWhileHeld, clock.now < allowed { Thread.sleep(forTimeInterval: 0.001) }
  }
}

@Test func aSaveBeingWrittenWhenItsSessionForgetsItsSignInLandsBeforeTheForgetDeletes()
  async throws
{
  let table = try casesTable()
  let seeded = try required(table, "forgetStorage").object.mapValues { try $0.text }
  let jo = try personKeyOf(table, "jo")
  let joOnA = try keysOf(table, kbId: "kb-a", personKey: jo)
  let resourceKey = try joOnA.query("resource")
  let user = try JSONEncoder().encode(required(table, "whoAmI"))
  let asked = try ResourceId("res-1")
  try await overGateway(.names, issuer: .refuses, user: user) { _, port, http in
    let storage = HoldingStorage(key: resourceKey)
    for key in joOnA.all {
      let text = try #require(seeded[key], "\(key) is not seeded")
      storage.set(key, text)
    }
    try storeSession(
      storage, kbId: "kb-a",
      session: signIn(
        personKey: jo, expired: false, tokenEndpoint: "http://127.0.0.1:\(port)/token"))
    let clock = TestClock()
    let opened = try await HttpSessionFactory(httpClient: http, clock: clock).session(
      SessionFactoryOptions(
        kb: knowledgeBase("kb-a", port: port), storage: storage, signals: SessionSignals(),
        onError: { _ in }))
    defer { opened.dispose() }
    let session = opened.session
    try await withinTestDeadline { try await session.ready() }
    #expect(session.user.value != nil, "the gateway named the person")
    let observed = Observed(opened.client.browse.resource(asked))
    let held = try await withinTestDeadline { try await observed.first() }
    observed.stop()
    #expect(held.name == "fresh")
    // The save is due saveDebounceMs after the value, by a clock that has not moved.
    let due = clock.now.advanced(by: .milliseconds(Timings.saveDebounceMs))
    try await withinTestDeadline {
      while !clock.wakes.contains(due) { try await Task.sleep(for: .milliseconds(1)) }
    }
    // A session ending its sign-in no longer names who its token is, last before it forgets it.
    storage.hold(until: { session.user.value == nil })
    clock.advance(by: .milliseconds(Timings.saveDebounceMs))
    try await withinTestDeadline {
      while !storage.holding { try await Task.sleep(for: .milliseconds(1)) }
    }
    // The session's own forget, as it expires: the issuer will not renew the token it holds.
    let token = session.token.value
    _ = try await withinTestDeadline { try await session.refresh(token) }
    try await withinTestDeadline {
      while !storage.written { try await Task.sleep(for: .milliseconds(1)) }
    }
    #expect(!storage.neverBegan, "the session's forget did not begin while the save was written")
    #expect(!storage.deletedWhileHeld, "the forget deleted while a save it deletes was in flight")
    #expect(try storedSession(storage, kbId: "kb-a") == nil, "the sign-in is kept")
    for key in joOnA.all {
      #expect(storage.get(key) == nil, "\(key) holds what was written after the forget deleted")
    }
  }
}
