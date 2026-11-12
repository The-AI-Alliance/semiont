import AsyncHTTPClient
import CryptoExtras
import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import Synchronization
import Testing

@testable import Semiont
@testable import SemiontTesting

private final class IssuerHandler: ChannelInboundHandler {
  typealias InboundIn = HTTPServerRequestPart
  typealias OutboundOut = HTTPServerResponsePart
  let respond: @Sendable (String, HTTPHeaders, Data) -> (Int, [String: JSONValue])
  var head: HTTPRequestHead?
  var body = Data()
  init(_ respond: @escaping @Sendable (String, HTTPHeaders, Data) -> (Int, [String: JSONValue])) {
    self.respond = respond
  }
  func channelRead(context: ChannelHandlerContext, data: NIOAny) {
    switch unwrapInboundIn(data) {
    case .head(let head):
      self.head = head
      body = Data()
    case .body(let chunk): body.append(contentsOf: chunk.readableBytesView)
    case .end:
      guard let head else { return }
      let (status, answer) = respond(head.uri, head.headers, body)
      guard let encoded = try? JSONEncoder().encode(answer) else { return }
      let response = HTTPResponseHead(
        version: .http1_1, status: HTTPResponseStatus(statusCode: status),
        headers: HTTPHeaders([
          ("Content-Type", "application/json"), ("Content-Length", String(encoded.count)),
        ]))
      context.write(wrapOutboundOut(.head(response)), promise: nil)
      context.write(wrapOutboundOut(.body(.byteBuffer(ByteBuffer(bytes: encoded)))), promise: nil)
      context.writeAndFlush(wrapOutboundOut(.end(nil)), promise: nil)
    }
  }
}
private func issuerServer<Value: Sendable>(
  _ respond: @escaping @Sendable (String, HTTPHeaders, Data) -> (Int, [String: JSONValue]),
  run: @Sendable (String, HTTPClient) async throws -> Value
) async throws -> Value {
  let channel = try await ServerBootstrap(group: MultiThreadedEventLoopGroup.singleton)
    .childChannelInitializer { channel in
      channel.eventLoop.makeCompletedFuture {
        try channel.pipeline.syncOperations.configureHTTPServerPipeline()
        try channel.pipeline.syncOperations.addHandler(IssuerHandler(respond))
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
private func form(_ data: Data) -> [String: String] {
  Dictionary(
    uniqueKeysWithValues: String(decoding: data, as: UTF8.self).split(separator: "&").map { part in
      let pair = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
      return (String(pair[0]), String(pair[1]).removingPercentEncoding ?? String(pair[1]))
    })
}
@Test func assertionsRunEverySharedCaseAndSignThePostedForm() async throws {
  let table = try Spec.read("session/client-assertion-cases.json").object
  for value in try required(table, "thumbprints").array {
    let row = try value.object
    let key = try required(row, "jwk").object
    let n = try #require(base64URLData(required(key, "n").text))
    let e = try #require(base64URLData(required(key, "e").text))
    #expect(try thumbprint(modulus: n, publicExponent: e) == required(row, "thumbprint").text)
  }
  for value in try required(table, "cases").array {
    let row = try value.object
    let key = try required(row, "jwk").object
    let n = try #require(base64URLData(required(key, "n").text))
    let e = try #require(base64URLData(required(key, "e").text))
    #expect(
      try JSONValue.object(assertionHeader(modulus: n, publicExponent: e))
        == required(row, "header"))
    let claims = try assertionClaims(
      clientId: required(row, "clientId").text, tokenEndpoint: required(row, "tokenEndpoint").text,
      issuedAt: Int(number(required(row, "issuedAt"))), jti: required(row, "jti").text)
    #expect(try JSONValue.object(claims) == required(row, "claims"))
  }
  let key = try _RSA.Signing.PrivateKey(keySize: .bits2048)
  let proof = try clientProof(
    .key(issuer: "issuer", clientId: "worker", privateKey: key), endpoint: "https://issuer/token")
  let posted = Dictionary(uniqueKeysWithValues: proof)
  #expect(Set(posted.keys) == Set(try required(table, "form").array.map { try $0.text }))
  #expect(try posted["grant_type"] == required(table, "grantType").text)
  #expect(try posted["client_assertion_type"] == required(table, "assertionType").text)
  let assertion = try #require(posted["client_assertion"])
  let parts = assertion.split(separator: ".")
  let bytes = try #require(base64URLData(String(parts[2])))
  #expect(
    key.publicKey.isValidSignature(
      _RSA.Signing.RSASignature(rawRepresentation: bytes),
      for: Data(parts.prefix(2).joined(separator: ".").utf8), padding: .insecurePKCS1v1_5))
  let claims = try JSONDecoder().decode(
    [String: JSONValue].self, from: #require(base64URLData(String(parts[1]))))
  #expect(
    try number(required(claims, "exp")) - number(required(claims, "iat"))
      == number(required(table, "lifetimeSeconds")))
  let second = try clientProof(
    .key(issuer: "issuer", clientId: "worker", privateKey: key), endpoint: "https://issuer/token")
  #expect(Dictionary(uniqueKeysWithValues: second)["client_assertion"] != assertion)
}
@Test func serviceTokenSerializesGrantsCachesThemAndNeverEchoesCredentials() async throws {
  let calls = Mutex(0)
  let origin = Mutex("")
  let token = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  try await issuerServer(
    { path, _, body in
      if path.hasSuffix("openid-configuration") {
        return (200, ["token_endpoint": .string(origin.withLock { $0 } + "/token")])
      }
      #expect(form(body)["client_secret"] == "secret&=☃")
      calls.withLock { $0 += 1 }
      return (200, ["access_token": .string(token), "expires_in": .number(3600)])
    },
    run: { base, http in
      origin.withLock { $0 = base }
      let credential = Credential.secret(
        issuer: base, clientId: "worker", clientSecret: "secret&=☃")
      #expect(!credential.description.contains("secret&"))
      let source = ServiceToken(credential: credential, httpClient: http)
      try await withThrowingTaskGroup(of: String.self) { group in
        for _ in 0..<10 { group.addTask { try await source.authorization() } }
        for try await value in group { #expect(value == "Bearer " + token) }
      }
      #expect(calls.withLock { $0 } == 1)
    })
}
@Test func whoAmIUsesOneRequestAndClassifiesCredentialRefusalRate() async throws {
  let calls = Mutex<[String]>([])
  try await issuerServer(
    { path, headers, _ in
      calls.withLock { $0.append(path) }
      #expect(headers.first(name: "Authorization") == "Bearer token")
      return (429, ["error": .string("refused"), "code": .string("refusal-rate")])
    },
    run: { base, http in
      do {
        _ = try await whoAmI(baseUrl: base, token: "token", httpClient: http)
        Issue.record("Refusal succeeded")
      } catch let error as TransportError {
        #expect(error.reason == .unauthorized)
        #expect(error.status == 429)
      }
    })
  #expect(calls.withLock { $0 } == ["/api/users/me"])
}
@Test func deviceSignInPollsThenKeepsRotatedTokensAndSignOutForgetsThem() async throws {
  let origin = Mutex("")
  let polls = Mutex(0)
  let requests = Mutex<[String]>([])
  let access = try jwt(
    .object(["iss": .string("https://issuer"), "exp": .number(Date().timeIntervalSince1970 + 3600)])
  )
  try await issuerServer(
    { path, _, data in
      requests.withLock { $0.append(path) }
      let base = origin.withLock { $0 }
      switch path {
      case "/.well-known/oauth-protected-resource":
        return (
          200,
          [
            "authorization_servers": .array([.string(base)]),
            "bearer_methods_supported": .array([.string("header")]),
            "resource": .string("https://kb"),
          ]
        )
      case "/.well-known/openid-configuration":
        return (
          200,
          [
            "issuer": .string(base), "authorization_endpoint": .string(base + "/authorize"),
            "token_endpoint": .string(base + "/token"),
            "device_authorization_endpoint": .string(base + "/device"),
            "revocation_endpoint": .string(base + "/revoke"),
          ]
        )
      case "/device":
        #expect(form(data)["client_id"] == scriptClientID)
        #expect(form(data)["scope"] == signInScope.value)
        return (
          200,
          [
            "device_code": .string("device"), "user_code": .string("ABCD"),
            "verification_uri": .string("https://issuer/approve"), "expires_in": .number(30),
            "interval": .number(0),
          ]
        )
      case "/token":
        let count = polls.withLock { value in
          value += 1
          return value
        }
        #expect(form(data)["device_code"] == "device")
        return count == 1
          ? (400, ["error": .string("authorization_pending")])
          : (200, ["access_token": .string(access), "refresh_token": .string("refresh")])
      case "/revoke":
        #expect(form(data)["token"] == "refresh")
        return (503, ["error": .string("unavailable")])
      default: return (404, [:])
      }
    },
    run: { base, http in
      origin.withLock { $0 = base }
      let url = try #require(URLComponents(string: base))
      let target = KbTarget(
        endpoint: .httpEndpoint(
          HttpEndpoint(host: "127.0.0.1", port: try #require(url.port), protocol: .http)),
        id: "test",
        label: "test")
      let kept = MemorySignIn()
      let codes = Mutex<[String]>([])
      try await signInDevice(kb: target, kept: kept, httpClient: http) { code in
        codes.withLock { $0.append(code.userCode) }
      }
      #expect(codes.withLock { $0 } == ["ABCD"])
      #expect(await kept.held()?.access == access)
      try await signOut(kept, httpClient: http)
      #expect(await kept.held() == nil)
    })
  #expect(polls.withLock { $0 } == 2)
  #expect(!requests.withLock { $0 }.contains("/bus/subscribe"))
}
@Test func anAgentKeepsItsTokenWhenRenewalIsRefused() async throws {
  let origin = Mutex("")
  let grants = Mutex(0)
  let asks = Mutex(0)
  let access = try jwt(
    .object(["iss": .string("issuer"), "exp": .number(Date().timeIntervalSince1970 + 3600)]))
  try await issuerServer(
    { path, _, _ in
      if path.hasSuffix("openid-configuration") {
        return (200, ["token_endpoint": .string(origin.withLock { $0 } + "/token")])
      }
      if path == "/token" {
        let count = grants.withLock { value in
          value += 1
          return value
        }
        return count == 1
          ? (200, ["access_token": .string(access)])
          : (401, ["error": .string("secret echoed by issuer")])
      }
      asks.withLock { $0 += 1 }
      return (
        200,
        [
          "did": .string("did:web:kb:agents:worker"), "domain": .string("kb"), "email": .null,
          "name": .null, "image": .null,
        ]
      )
    },
    run: { base, http in
      origin.withLock { $0 = base }
      let service = ServiceToken(
        credential: .secret(issuer: base, clientId: "worker", clientSecret: "secret"),
        httpClient: http)
      let agent = AgentToken(gateway: base, service: service, httpClient: http)
      defer { agent.dispose() }
      try await agent.signIn()
      #expect(try await agent.did.value == "did:web:kb:agents:worker")
      #expect(try await agent.refresh(access) == nil)
      #expect(agent.token.value == access)
      #expect(asks.withLock { $0 } == 1)
      do {
        _ = try await service.token(renewed: true)
        Issue.record("Refused grant succeeded")
      } catch let error as SignInError { #expect(!error.description.contains("secret")) }
    })
}
// A wait is for the token it was counted from. The issuer answers an agent's renewal on its
// schedule "not now", so it is tried again on the refresh backoff; a refusal renews the token in
// between, and the attempt after it renews nothing.
@Test func anAgentsScheduledRenewalRenewsNothingOnceARefusalHasRenewedItsToken() async throws {
  let origin = Mutex("")
  let grants = Mutex(0)
  let now = Date().timeIntervalSince1970
  // It falls due minRefreshDelayMs after the agent signs in.
  let first = try jwt(.object(["exp": .number(now + 20), "iat": .number(now)]))
  let renewed = try jwt(.object(["exp": .number(now + 3600), "name": .string("renewed")]))
  let again = try jwt(.object(["exp": .number(now + 3600), "name": .string("again")]))
  try await issuerServer(
    { path, _, _ in
      if path.hasSuffix("openid-configuration") {
        return (200, ["token_endpoint": .string(origin.withLock { $0 } + "/token")])
      }
      if path == "/token" {
        let count = grants.withLock { value in
          value += 1
          return value
        }
        switch count {
        case 1: return (200, ["access_token": .string(first)])
        case 2: return (503, [:])
        case 3: return (200, ["access_token": .string(renewed)])
        default: return (200, ["access_token": .string(again)])
        }
      }
      return (
        200,
        [
          "did": .string("did:web:kb:agents:worker"), "domain": .string("kb"), "email": .null,
          "name": .null, "image": .null,
        ]
      )
    },
    run: { base, http in
      origin.withLock { $0 = base }
      let clock = TestClock()
      let service = ServiceToken(
        credential: .secret(issuer: base, clientId: "worker", clientSecret: "secret"),
        httpClient: http, clock: clock)
      let agent = AgentToken(gateway: base, service: service, httpClient: http)
      defer { agent.dispose() }
      try await agent.signIn()
      let due = clock.now.advanced(by: .milliseconds(Timings.minRefreshDelayMs))
      try await withinTestDeadline {
        while !clock.wakes.contains(where: { $0 <= due }) {
          try await Task.sleep(for: .milliseconds(1))
        }
      }
      clock.advance(by: .milliseconds(Timings.minRefreshDelayMs))
      let retried = clock.now.advanced(by: .milliseconds(Timings.refreshRetry.initialDelayMs))
      try await withinTestDeadline {
        while !clock.wakes.contains(where: { $0 <= retried }) {
          try await Task.sleep(for: .milliseconds(1))
        }
      }
      #expect(grants.withLock { $0 } == 2)
      #expect(try await agent.refresh(first) == renewed)
      clock.advance(by: .milliseconds(Timings.refreshRetry.initialDelayMs))
      // An attempt that renewed anyway would have reached the issuer by now.
      try await Task.sleep(for: .milliseconds(240))
      #expect(grants.withLock { $0 } == 3, "the scheduled renewal renewed the refusal's token")
      #expect(agent.token.value == renewed)
    })
}
// The issuer holds its answer to a refusal's grant, on the server's own thread, while the agent is
// disposed.
@Test func anAgentDisposedWhileItsTokenIsRenewedGivesTheRefusalNoTokenAndRenewsNothingAfter()
  async throws
{
  let origin = Mutex("")
  let grants = Mutex(0)
  let holding = Watched(false)
  let granting = DispatchSemaphore(value: 0)
  let now = Date().timeIntervalSince1970
  let first = try jwt(.object(["exp": .number(now + 3600), "name": .string("first")]))
  let second = try jwt(.object(["exp": .number(now + 3600), "name": .string("second")]))
  let late = try jwt(.object(["exp": .number(now + 3600), "name": .string("late")]))
  try await issuerServer(
    { path, _, _ in
      if path.hasSuffix("openid-configuration") {
        return (200, ["token_endpoint": .string(origin.withLock { $0 } + "/token")])
      }
      if path == "/token" {
        let count = grants.withLock { value in
          value += 1
          return value
        }
        switch count {
        case 1: return (200, ["access_token": .string(first)])
        case 2: return (200, ["access_token": .string(second)])
        default: break
        }
        holding.set(true)
        _ = granting.wait(timeout: .now() + 10)
        return (200, ["access_token": .string(late)])
      }
      return (
        200,
        [
          "did": .string("did:web:kb:agents:worker"), "domain": .string("kb"), "email": .null,
          "name": .null, "image": .null,
        ]
      )
    },
    run: { base, http in
      defer { granting.signal() }
      origin.withLock { $0 = base }
      let service = ServiceToken(
        credential: .secret(issuer: base, clientId: "worker", clientSecret: "secret"),
        httpClient: http)
      let agent = AgentToken(gateway: base, service: service, httpClient: http)
      defer { agent.dispose() }
      try await agent.signIn()
      #expect(try await agent.refresh(first) == second)
      let refusing = Task { try await agent.refresh(second) }
      try await withinTestDeadline { for await held in holding where held { return } }
      agent.dispose()
      // The dispose ended the renewal: the refusal is given no token, rather than a cancellation
      // it never had.
      #expect(try await withinTestDeadline { try await refusing.value } == nil)
      // A disposed agent gives no token, whatever token was refused, and asks the issuer for
      // nothing.
      #expect(try await agent.refresh(second) == nil)
      #expect(try await agent.refresh(first) == nil)
      // The answer that comes later is not taken.
      granting.signal()
      #expect(try await withinTestDeadline { try await service.token(renewed: false) } == late)
      #expect(agent.token.value == second)
      #expect(grants.withLock { $0 } == 3)
    })
}
@Test func immediateStreamAndStartupRefusalsShareTheSessionsRenewal() async throws {
  let grants = Mutex(0)
  let asks = Mutex(0)
  let old = try jwt(
    .object([
      "iss": .string("issuer"), "name": .string("old"),
      "exp": .number(Date().timeIntervalSince1970 + 3600),
    ]))
  let renewed = try jwt(
    .object([
      "iss": .string("issuer"), "name": .string("new"),
      "exp": .number(Date().timeIntervalSince1970 + 3600),
    ]))
  try await issuerServer(
    { path, headers, _ in
      if path == "/token" {
        grants.withLock { $0 += 1 }
        return (200, ["access_token": .string(renewed)])
      }
      if headers.first(name: "Authorization") == "Bearer " + old {
        return (401, ["error": .string("refused")])
      }
      if path == "/api/users/me" {
        asks.withLock { $0 += 1 }
        return (
          200,
          [
            "did": .string("did:web:kb:users:alice"), "domain": .string("kb"), "email": .null,
            "name": .null, "image": .null,
          ]
        )
      }
      return (200, [:])
    },
    run: { origin, http in
      let port = try #require(URLComponents(string: origin)?.port)
      let target = KbTarget(
        endpoint: .httpEndpoint(HttpEndpoint(host: "127.0.0.1", port: port, protocol: .http)),
        id: "test", label: "test")
      let kept = MemorySignIn(
        HeldSignIn(
          access: old, clientId: scriptClientID, refresh: "refresh",
          tokenEndpoint: origin + "/token")
      )
      let opened = try await sessionFromKept(kb: target, kept: kept, httpClient: http)
      defer { opened.dispose() }
      try await opened.session.ready()
      #expect(opened.session.token.value == renewed)
      #expect(opened.session.user.value?.did.value == "did:web:kb:users:alice")
      #expect(grants.withLock { $0 } == 1)
      #expect(asks.withLock { $0 } == 1)
      #expect(opened.client.baseUrl == origin)
      let auth = try #require(opened.client.auth)
      #expect(try await auth.me().did == opened.session.user.value?.did)
      #expect(asks.withLock { $0 } == 2)
      opened.dispose()
      #expect(opened.client.state.value == .closed)
    })
}

// A session opened over a kept sign-in asks the gateway who its token is unless it is told not
// to: leaving `validate` out asks once, and `validate: false` asks nobody.
@Test func aSessionOverAKeptSignInAsksWhoItsTokenIsUnlessToldNotTo() async throws {
  let access = try jwt(
    .object(["iss": .string("issuer"), "exp": .number(Date().timeIntervalSince1970 + 3600)]))
  for validate in [nil, false] as [Bool?] {
    let why = validate.map { "validate: \($0)" } ?? "validate left out"
    let asks = Mutex(0)
    try await issuerServer(
      { path, _, _ in
        guard path == "/api/users/me" else { return (200, [:]) }
        asks.withLock { $0 += 1 }
        return (
          200,
          [
            "did": .string("did:web:kb:users:alice"), "domain": .string("kb"), "email": .null,
            "name": .null, "image": .null,
          ]
        )
      },
      run: { origin, http in
        let port = try #require(URLComponents(string: origin)?.port)
        let target = KbTarget(
          endpoint: .httpEndpoint(HttpEndpoint(host: "127.0.0.1", port: port, protocol: .http)),
          id: "test", label: "test")
        let kept = MemorySignIn(
          HeldSignIn(
            access: access, clientId: scriptClientID, refresh: "refresh",
            tokenEndpoint: origin + "/token"))
        let opened: OpenedSession
        if let validate {
          opened = try await sessionFromKept(
            kb: target, kept: kept, httpClient: http, validate: validate)
        } else {
          opened = try await sessionFromKept(kb: target, kept: kept, httpClient: http)
        }
        defer { opened.dispose() }
        try await withinTestDeadline { try await opened.session.ready() }
        #expect(opened.session.token.value == access, "\(why)")
        if validate == false {
          #expect(asks.withLock { $0 } == 0, "\(why)")
          #expect(opened.session.user.value == nil, "\(why)")
        } else {
          #expect(asks.withLock { $0 } == 1, "\(why)")
          #expect(opened.session.user.value?.did.value == "did:web:kb:users:alice", "\(why)")
        }
      })
  }
}

@Test func aSignInBegunIsKeptAsTheStoredTableStatesIt() async throws {
  let origin = Mutex("")
  try await issuerServer(
    { path, _, _ in
      let base = origin.withLock { $0 }
      switch path {
      case "/.well-known/oauth-protected-resource":
        return (
          200,
          [
            "authorization_servers": .array([.string(base)]),
            "bearer_methods_supported": .array([.string("header")]),
            "resource": .string("https://kb"),
          ]
        )
      case "/.well-known/openid-configuration":
        return (
          200,
          [
            "issuer": .string(base), "authorization_endpoint": .string(base + "/authorize"),
            "token_endpoint": .string(base + "/token"),
          ]
        )
      default: return (404, [:])
      }
    },
    run: { base, http in
      origin.withLock { $0 = base }
      let schema = try required(Spec.read("session/stored.json").object, "pendingAuthorization")
        .object
      let issuerSchema = try required(required(schema, "properties").object, "issuer").object
      func members(_ schema: [String: JSONValue]) throws -> Set<String> {
        Set(try required(schema, "properties").object.keys)
      }
      func requiredMembers(_ schema: [String: JSONValue]) throws -> Set<String> {
        Set(try required(schema, "required").array.map { try $0.text })
      }
      let url = try #require(URLComponents(string: base))
      let target = HttpEndpoint(host: "127.0.0.1", port: try #require(url.port), protocol: .http)
      func kept(_ options: BeginAuthorizationOptions) async throws -> [String: JSONValue] {
        let storage = MemorySessionStorage()
        _ = try await beginAuthorization(options, storage: storage, httpClient: http)
        let text = try #require(storage.get(pendingAuthorizationKey))
        return try JSONDecoder().decode(JSONValue.self, from: Data(text.utf8)).object
      }
      let full = try await kept(
        BeginAuthorizationOptions(
          target: target, redirectUri: "semiont://sign-in", kbId: "kb-a",
          expectedDid: "did:web:kb-a", expectedName: "A"))
      #expect(Set(full.keys) == (try members(schema)))
      let issuer = Set(try required(full, "issuer").object.keys)
      #expect((try requiredMembers(issuerSchema)).isSubset(of: issuer))
      #expect(issuer.isSubset(of: try members(issuerSchema)))
      let bare = try await kept(
        BeginAuthorizationOptions(target: target, redirectUri: "semiont://sign-in"))
      #expect(Set(bare.keys) == (try requiredMembers(schema)))
    })
}

@Test func concurrentRedirectCallbacksExchangeTheCodeOnce() async throws {
  let origin = Mutex("")
  let verifier = Mutex("")
  let exchanges = Mutex(0)
  let redirect = "semiont://sign-in?where=a+b"
  try await issuerServer(
    { path, _, body in
      let base = origin.withLock { $0 }
      switch path {
      case "/.well-known/oauth-protected-resource":
        return (
          200,
          [
            "authorization_servers": .array([.string(base)]),
            "bearer_methods_supported": .array([.string("header")]),
            "resource": .string("https://kb"),
          ]
        )
      case "/.well-known/openid-configuration":
        return (
          200,
          [
            "issuer": .string(base),
            "authorization_endpoint": .string(base + "/authorize?keep=yes"),
            "token_endpoint": .string(base + "/token"),
          ]
        )
      case "/token":
        exchanges.withLock { $0 += 1 }
        let posted = form(body)
        #expect(posted["code"] == "one-use-code")
        #expect(posted["grant_type"] == "authorization_code")
        #expect(posted["redirect_uri"] == redirect)
        #expect(posted["code_verifier"] == verifier.withLock { $0 })
        return (200, ["access_token": .string("access"), "refresh_token": .string("refresh")])
      default: return (404, [:])
      }
    },
    run: { base, http in
      origin.withLock { $0 = base }
      let url = try #require(URLComponents(string: base))
      let target = HttpEndpoint(host: "127.0.0.1", port: try #require(url.port), protocol: .http)
      let storage = MemorySessionStorage()
      let address = try await beginAuthorization(
        BeginAuthorizationOptions(target: target, redirectUri: redirect), storage: storage,
        httpClient: http)
      let pending = try #require(
        decodedStorage(PendingAuthorization.self, storage.get(pendingAuthorizationKey)))
      verifier.withLock { $0 = pending.verifier }
      let components = try #require(URLComponents(string: address))
      let parameters = Dictionary(
        uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
      #expect(parameters["keep"] == "yes")
      #expect(parameters["code_challenge"] == codeChallenge(pending.verifier))
      #expect(parameters["code_challenge_method"] == "S256")
      #expect(parameters["state"] == pending.state)
      #expect(parameters["redirect_uri"] == redirect)
      #expect(address.contains("a%2Bb"))
      let callback = redirect + "&state=" + pending.state + "&code=one-use-code"
      let signedInCount = try await withThrowingTaskGroup(of: Bool.self) { group in
        for _ in 0..<2 {
          group.addTask {
            do {
              let (_, session) = try await completeAuthorization(
                callback, storage: storage, httpClient: http)
              #expect(session.access == "access")
              #expect(session.refresh == "refresh")
              return true
            } catch let error as SignInError where error.reason == .noPending {
              return false
            }
          }
        }
        var signedIn = 0
        for try await accepted in group where accepted { signedIn += 1 }
        return signedIn
      }
      #expect(signedInCount == 1)
      #expect(storage.get(pendingAuthorizationKey) == nil)
    })
  #expect(exchanges.withLock { $0 } == 1)
}
