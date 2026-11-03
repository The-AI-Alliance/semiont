import AsyncHTTPClient
import CryptoExtras
import Foundation
import NIOCore
import NIOHTTP1
import NIOPosix
import Synchronization
import Testing

@testable import Semiont

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
    })
}
