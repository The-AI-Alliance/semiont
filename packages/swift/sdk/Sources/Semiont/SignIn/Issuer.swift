import AsyncHTTPClient
import Foundation

struct IssuerAnswer: Sendable {
  let status: Int
  let body: [String: JSONValue]?
  func text(_ key: String) -> String? {
    guard case .string(let value) = body?[key] else { return nil }
    return value
  }
  func seconds(_ key: String) -> Double? {
    guard case .number(let value) = body?[key], value >= 0 else { return nil }
    return value
  }
}
func issuerRequest(
  _ url: String, http: HTTPClient, form: [(String, String)]? = nil, bearer: String? = nil
) async throws -> (HTTPClientResponse, Data) {
  var request = HTTPClientRequest(url: url)
  request.headers.add(name: "Accept", value: "application/json")
  if let bearer { request.headers.add(name: "Authorization", value: "Bearer " + bearer) }
  if let form {
    request.method = .POST
    request.headers.add(name: "Content-Type", value: "application/x-www-form-urlencoded")
    request.body = .bytes(
      Data(
        form.map { encodeUriComponent($0.0) + "=" + encodeUriComponent($0.1) }.joined(
          separator: "&"
        ).utf8))
  }
  return try await within(Timings.httpRequestTimeoutMs) { [request] in
    let response = try await http.execute(request, deadline: .distantFuture)
    var data = Data()
    for try await chunk in response.body { data.append(contentsOf: chunk.readableBytesView) }
    return (response, data)
  }
}
func issuerAnswer(_ url: String, http: HTTPClient, form: [(String, String)]? = nil) async throws
  -> IssuerAnswer
{
  do {
    let (response, data) = try await issuerRequest(url, http: http, form: form)
    return IssuerAnswer(
      status: Int(response.status.code),
      body: (try? JSONDecoder().decode([String: JSONValue].self, from: data)))
  } catch {
    if Task.isCancelled { throw CancellationError() }
    throw SignInError(.exchange, "The issuer did not answer")
  }
}
struct IssuedTokens: Sendable {
  let access: String
  let refresh: String
}
func refreshAtIssuer(_ held: HeldSignIn, http: HTTPClient) async throws -> IssuedTokens {
  let answer = try await issuerAnswer(
    held.tokenEndpoint, http: http,
    form: [
      ("grant_type", "refresh_token"), ("refresh_token", held.refresh),
      ("client_id", held.clientId),
    ])
  guard answer.status == 200, let access = answer.text("access_token") else {
    throw SignInError(
      .exchange, "The issuer refused the refresh grant (HTTP \(answer.status))",
      status: answer.status)
  }
  return IssuedTokens(access: access, refresh: answer.text("refresh_token") ?? held.refresh)
}
func retryRenewal<Value: Sendable>(_ grant: @escaping @Sendable () async throws -> Value)
  async throws -> Value
{
  let budget = Timings.refreshRetry
  return try await retryWithBackoff(
    attempts: budget.attempts, initialDelayMs: budget.initialDelayMs,
    maxDelayMs: budget.maxDelayMs,
    retryable: {
      RetryContext.refresh.retryable(status: ($0 as? SignInError)?.status, method: "POST")
    },
    operation: { attempt in
      do {
        return try await grant()
      } catch let failure as SignInError where attempt > 1 {
        throw SignInError(
          failure.reason, "Renewal failed after \(attempt) attempts: \(failure.description)",
          status: failure.status)
      }
    })
}
func renewKept(
  _ kept: any SignInKept, holding: String?,
  grant: @escaping @Sendable (HeldSignIn) async throws -> IssuedTokens
) async throws -> String? {
  guard let held = try await kept.held() else { return nil }
  if held.access != holding, !isTokenExpired(held.access, now: Date().timeIntervalSince1970) {
    return held.access
  }
  let tokens = try await grant(held)
  return try await kept.renewed(read: held, access: tokens.access, refresh: tokens.refresh)
}
public func renewKept(_ kept: any SignInKept, holding: String?, httpClient: HTTPClient) async throws
  -> String?
{
  try await renewKept(kept, holding: holding) { held in
    try await retryRenewal { try await refreshAtIssuer(held, http: httpClient) }
  }
}
struct IssuerEndpoints: Codable, Sendable {
  let issuer: String
  let authorization: String
  let token: String
  let device: String?
  let revocation: String?
}
func oidcConfiguration(_ issuer: String, http: HTTPClient) async throws -> IssuerAnswer {
  do {
    return try await issuerAnswer(
      issuer.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        + "/.well-known/openid-configuration", http: http)
  } catch {
    if Task.isCancelled { throw CancellationError() }
    throw SignInError(.discovery, "OIDC discovery did not answer")
  }
}
func discoverIssuer(_ gateway: String, http: HTTPClient) async throws -> IssuerEndpoints {
  let metadata: ProtectedResourceMetadata
  do {
    let (response, data) = try await issuerRequest(
      gateway + "/.well-known/oauth-protected-resource", http: http)
    if response.status.code == 404 {
      throw SignInError(.noIssuer, "The knowledge base trusts no external issuer")
    }
    guard (200..<300).contains(response.status.code) else {
      throw SignInError(
        .discovery, "The gateway refused metadata discovery", status: Int(response.status.code))
    }
    metadata = try JSONDecoder().decode(ProtectedResourceMetadata.self, from: data)
  } catch let failure as SignInError { throw failure } catch {
    if Task.isCancelled { throw CancellationError() }
    throw SignInError(.discovery, "The gateway did not answer resource metadata")
  }
  guard let issuer = metadata.authorization_servers.first else {
    throw SignInError(.noIssuer, "The knowledge base trusts no external issuer")
  }
  let document = try await oidcConfiguration(issuer, http: http)
  guard (200..<300).contains(document.status), document.text("issuer") == issuer,
    let authorization = document.text("authorization_endpoint"),
    let token = document.text("token_endpoint")
  else {
    throw SignInError(
      .discovery, "The issuer did not answer its OpenID configuration", status: document.status)
  }
  return IssuerEndpoints(
    issuer: issuer, authorization: authorization, token: token,
    device: document.text("device_authorization_endpoint"),
    revocation: document.text("revocation_endpoint"))
}
public struct DeviceCode: Sendable {
  public let userCode: String
  public let verificationUri: String
  public let verificationUriComplete: String?
  public let expiresIn: Double
}
public func signInDevice(
  kb: KbTarget, kept: any SignInKept, httpClient: HTTPClient, onCode: @Sendable (DeviceCode) -> Void
) async throws {
  guard case .httpEndpoint(let endpoint) = kb.endpoint else {
    throw SignInError(.discovery, "The device grant needs an HTTP endpoint")
  }
  let issuer = try await discoverIssuer(gatewayUrl(endpoint), http: httpClient)
  guard let device = issuer.device else {
    throw SignInError(.discovery, "The issuer has no device authorization endpoint")
  }
  let answer = try await issuerAnswer(
    device, http: httpClient, form: [("client_id", scriptClientID), ("scope", signInScope.value)])
  guard answer.status == 200, let deviceCode = answer.text("device_code"),
    let userCode = answer.text("user_code"), let uri = answer.text("verification_uri"),
    let expires = answer.seconds("expires_in"), expires < Double(Int.max / 1000)
  else {
    throw SignInError(.exchange, "The issuer refused device authorization", status: answer.status)
  }
  onCode(
    DeviceCode(
      userCode: userCode, verificationUri: uri,
      verificationUriComplete: answer.text("verification_uri_complete"), expiresIn: expires))
  var interval = max(
    answer.seconds("interval") ?? Double(Timings.devicePollMs) / 1000,
    Double(Timings.devicePollFloorMs) / 1000)
  let deadline = ContinuousClock.now.advanced(by: .milliseconds(Int(expires * 1000)))
  while true {
    guard interval < Double(Int.max / 1000) else {
      throw SignInError(.expired, "The device code expired")
    }
    let next = ContinuousClock.now.advanced(by: .milliseconds(Int(interval * 1000)))
    try await ContinuousClock().sleep(until: min(next, deadline))
    guard ContinuousClock.now < deadline else {
      throw SignInError(.expired, "The device code expired")
    }
    let polled = try await issuerAnswer(
      issuer.token, http: httpClient,
      form: [
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"), ("device_code", deviceCode),
        ("client_id", scriptClientID),
      ])
    if polled.status == 200, let access = polled.text("access_token") {
      guard let refresh = polled.text("refresh_token") else {
        throw SignInError(.exchange, "The issuer returned no refresh token")
      }
      try await kept.keep(
        HeldSignIn(
          access: access, clientId: scriptClientID, refresh: refresh,
          revocationEndpoint: issuer.revocation, tokenEndpoint: issuer.token))
      return
    }
    switch polled.text("error") {
    case "authorization_pending": break
    case "slow_down": interval += Double(Timings.deviceSlowDownMs) / 1000
    case "access_denied":
      throw SignInError(.denied, "The sign-in was denied", status: polled.status)
    case "expired_token": throw SignInError(.expired, "The device code expired")
    default:
      throw SignInError(.exchange, "The issuer refused the device grant", status: polled.status)
    }
  }
}
public func signOut(_ kept: any SignInKept, httpClient: HTTPClient) async throws {
  guard let held = try await kept.held() else { return }
  if let endpoint = held.revocationEndpoint {
    _ = try? await issuerAnswer(
      endpoint, http: httpClient,
      form: [
        ("token", held.refresh), ("token_type_hint", "refresh_token"), ("client_id", held.clientId),
      ])
  }
  try await kept.forget()
}
/// One request, with no transport or automatic credential renewal.
public func whoAmI(baseUrl: String, token: String, httpClient: HTTPClient) async throws
  -> UserResponse
{
  let response: HTTPClientResponse
  let data: Data
  do {
    (response, data) = try await issuerRequest(
      baseUrl + "/api/users/me", http: httpClient, bearer: token)
  } catch {
    if Task.isCancelled { throw CancellationError() }
    throw TransportError(.unavailable, "The gateway did not answer who the token is")
  }
  let status = Int(response.status.code)
  guard (200..<300).contains(status) else {
    let body = try? JSONDecoder().decode(ErrorResponse.self, from: data)
    throw TransportError(
      status == 429 && body?.code == "refusal-rate"
        ? .unauthorized : transportErrorCode(for: status), "The gateway refused the credential",
      status: status)
  }
  do { return try JSONDecoder().decode(UserResponse.self, from: data) } catch {
    throw TransportError(.error, "The gateway answered an invalid user", status: status)
  }
}
