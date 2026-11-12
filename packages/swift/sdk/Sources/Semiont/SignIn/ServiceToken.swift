import AsyncHTTPClient
import Crypto
import CryptoExtras
import Foundation

public enum Credential: Sendable, CustomStringConvertible {
  case secret(issuer: String, clientId: String, clientSecret: String)
  case key(issuer: String, clientId: String, privateKey: _RSA.Signing.PrivateKey)
  public var description: String { "Credential(issuer: \(issuer), clientId: \(clientID))" }
  var issuer: String {
    switch self {
    case .secret(let issuer, _, _), .key(let issuer, _, _): issuer
    }
  }
  var clientID: String {
    switch self {
    case .secret(_, let client, _), .key(_, let client, _): client
    }
  }
}
func thumbprint(modulus: Data, publicExponent: Data) -> String {
  let canonical =
    "{\"e\":\"\(base64URL(publicExponent))\",\"kty\":\"RSA\",\"n\":\"\(base64URL(modulus))\"}"
  return base64URL(Data(SHA256.hash(data: Data(canonical.utf8))))
}
func assertionHeader(modulus: Data, publicExponent: Data) -> [String: JSONValue] {
  [
    "alg": .string("RS256"),
    "kid": .string(thumbprint(modulus: modulus, publicExponent: publicExponent)),
  ]
}
func assertionClaims(clientId: String, tokenEndpoint: String, issuedAt: Int, jti: String)
  -> [String: JSONValue]
{
  [
    "iss": .string(clientId), "sub": .string(clientId), "aud": .string(tokenEndpoint),
    "iat": .number(Double(issuedAt)), "exp": .number(Double(issuedAt + 60)), "jti": .string(jti),
  ]
}
func clientAssertion(
  key: _RSA.Signing.PrivateKey, clientId: String, endpoint: String, issuedAt: Int, jti: String
) throws -> String {
  let publicKey = try key.publicKey.getKeyPrimitives()
  let header = assertionHeader(modulus: publicKey.modulus, publicExponent: publicKey.publicExponent)
  let claims = assertionClaims(
    clientId: clientId, tokenEndpoint: endpoint, issuedAt: issuedAt, jti: jti)
  let input = try [header, claims].map { base64URL(try JSONEncoder().encode($0)) }.joined(
    separator: ".")
  let signature = try key.signature(for: Data(input.utf8), padding: .insecurePKCS1v1_5)
  return input + "." + base64URL(signature.rawRepresentation)
}
func clientProof(_ credential: Credential, endpoint: String) throws -> [(String, String)] {
  switch credential {
  case .secret(_, let clientId, let secret):
    return [
      ("grant_type", "client_credentials"), ("client_id", clientId), ("client_secret", secret),
    ]
  case .key(_, let clientId, let key):
    return [
      ("grant_type", "client_credentials"),
      ("client_assertion_type", "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"),
      (
        "client_assertion",
        try clientAssertion(
          key: key, clientId: clientId, endpoint: endpoint,
          issuedAt: Int(Date().timeIntervalSince1970), jti: UUID().uuidString)
      ),
    ]
  }
}
public actor ServiceToken {
  private let credential: Credential
  private let http: HTTPClient
  nonisolated let clock: any Clock<Duration>
  private var endpoint: String?
  private var held: (token: String, age: @Sendable () -> Duration, until: Duration)?
  private var asking: Task<String, any Error>?
  private let lifetime = Lifetime()
  public init(
    credential: Credential, httpClient: HTTPClient, clock: any Clock<Duration> = ContinuousClock()
  ) {
    self.credential = credential
    http = httpClient
    self.clock = clock
  }
  public func authorization() async throws -> String {
    "Bearer " + (try await token(renewed: false))
  }
  func token(renewed: Bool) async throws -> String {
    if let asking { return try await sharedValue(asking, lifetime: lifetime) }
    if !renewed, let held, held.age() < held.until { return held.token }
    let task = spawn(on: self) { service in
      defer { service.asking = nil }
      return try await service.grant()
    }
    asking = task
    return try await sharedValue(task, lifetime: lifetime)
  }
  private func grant() async throws -> String {
    let tokenEndpoint: String
    if let endpoint {
      tokenEndpoint = endpoint
    } else {
      let document = try await oidcConfiguration(credential.issuer, http: http, clock: clock)
      guard (200..<300).contains(document.status), let found = document.text("token_endpoint")
      else {
        throw SignInError(
          .discovery, "OIDC discovery returned no token endpoint", status: document.status)
      }
      endpoint = found
      tokenEndpoint = found
    }
    let answer = try await issuerAnswer(
      tokenEndpoint, http: http, clock: clock,
      form: clientProof(credential, endpoint: tokenEndpoint))
    guard (200..<300).contains(answer.status), let token = answer.text("access_token") else {
      throw SignInError(
        .exchange,
        "Client-credentials grant for \(credential.clientID) failed (HTTP \(answer.status))",
        status: answer.status)
    }
    let lifetime = answer.seconds("expires_in")
    if let due = refreshDelay(token, now: Date().timeIntervalSince1970)
      ?? lifetime.map({ renewalDelay(lifetime: $0, remaining: $0) })
    {
      let delay = lifetime.map { min($0, due) } ?? due
      if delay < Double(Int.max / 1000) {
        held = (token, stopwatch(clock), .milliseconds(Int(delay * 1000)))
      } else {
        held = nil
      }
    } else {
      held = nil
    }
    return token
  }
}
public actor AgentToken {
  public nonisolated let gateway: String
  public nonisolated let token = Watched<String?>(nil)
  private let service: ServiceToken
  private let http: HTTPClient
  private nonisolated let random: RandomSource
  private nonisolated let lifetime = Lifetime()
  private var signedInAs: UserId?
  private var signing = false
  private var renewal: Task<String, any Error>?
  private var scheduled: UUID?
  public init(
    gateway: String, service: ServiceToken, httpClient: HTTPClient,
    random: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator()
  ) {
    self.gateway = gateway.hasSuffix("/") ? String(gateway.dropLast()) : gateway
    self.service = service
    self.http = httpClient
    self.random = RandomSource(random)
    let token = token
    lifetime.onEnd { token.finish(with: token.value) }
  }
  public var did: UserId {
    get throws {
      guard let signedInAs else { throw SignInError(.exchange, "The agent is not signed in") }
      return signedInAs
    }
  }
  public func signIn() async throws {
    guard !signing, !lifetime.ended else { throw SignInError(.exchange, "An agent signs in once") }
    signing = true
    let id = UUID()
    let task = spawn(on: self) { agent in
      defer { agent.lifetime.forget(id) }
      let current = try await agent.service.token(renewed: false)
      let named = try await whoAmI(
        baseUrl: agent.gateway, token: current, httpClient: agent.http, clock: agent.service.clock)
      try Task.checkCancellation()
      guard !agent.lifetime.ended else { throw CancellationError() }
      agent.signedInAs = named.did
      agent.token.set(current)
      agent.schedule()
    }
    lifetime.keep(task, id: id)
    try await withTaskCancellationHandler {
      _ = try await sharedValue(task, lifetime: lifetime)
    } onCancel: {
      task.cancel()
    }
  }
  public func refresh(_ refused: String?) async throws -> String? {
    guard !lifetime.ended else { throw CancellationError() }
    do { return try await renew(refused) } catch is SignInError { return nil }
  }
  /// Renews `held` while it is the token the agent holds, in the renewal in flight or in one it
  /// starts. A token the agent no longer holds was renewed already: the token it holds is given.
  private func renew(_ held: String?) async throws -> String? {
    if token.value != held { return token.value }
    if let renewal { return try await sharedValue(renewal, lifetime: lifetime) }
    let id = UUID()
    let task = spawn(on: self) { agent in
      defer {
        agent.renewal = nil
        agent.lifetime.forget(id)
      }
      let next = try await agent.service.token(renewed: true)
      try Task.checkCancellation()
      guard !agent.lifetime.ended else { throw CancellationError() }
      agent.token.set(next)
      agent.schedule()
      return next
    }
    renewal = task
    lifetime.keep(task, id: id)
    return try await sharedValue(task, lifetime: lifetime)
  }
  private func schedule() {
    if let scheduled {
      lifetime.cancel(scheduled)
      self.scheduled = nil
    }
    guard !lifetime.ended, let current = token.value,
      let due = refreshDelay(current, now: Date().timeIntervalSince1970),
      due < Double(Int.max / 1000)
    else { return }
    let id = UUID()
    let life = lifetime
    let clock = service.clock
    let task = spawn { [weak self] in
      defer { life.forget(id) }
      do {
        try await sleepMilliseconds(Int(due * 1000), on: clock)
        guard !life.ended else { return }
        await self?.due(id, counted: current)
      } catch {}
    }
    scheduled = id
    life.keep(task, id: id)
  }
  /// The wait `id`, counted from the token `counted`, has run out. A wait that ran out as `schedule`
  /// replaced it reaches here all the same, so only the wait still scheduled renews, and each of its
  /// attempts renews `counted` only while it is still the token held.
  private func due(_ id: UUID, counted: String) async {
    guard scheduled == id else { return }
    scheduled = nil
    do {
      _ = try await retryRenewal(clock: service.clock, random: random) {
        try await self.renew(counted)
      }
    } catch is CancellationError {} catch { schedule() }
  }
  public nonisolated func dispose() { lifetime.end() }
  deinit { lifetime.end() }
}
