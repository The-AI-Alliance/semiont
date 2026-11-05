import AsyncHTTPClient
import Crypto
import Foundation
import Synchronization

public struct BeginAuthorizationOptions: Sendable {
  public let target: HttpEndpoint
  public let redirectUri: String
  public let kbId: String?
  public let expectedDid: String?
  public let expectedName: String?

  public init(
    target: HttpEndpoint, redirectUri: String, kbId: String? = nil,
    expectedDid: String? = nil, expectedName: String? = nil
  ) {
    self.target = target
    self.redirectUri = redirectUri
    self.kbId = kbId
    self.expectedDid = expectedDid
    self.expectedName = expectedName
  }
}

public struct PendingAuthorization: Codable, Sendable {
  public let state: String
  public let verifier: String
  public let redirectUri: String
  public let target: HttpEndpoint
  let issuer: IssuerEndpoints
  public let kbId: String?
  public let expectedDid: String?
  public let expectedName: String?
}

private var browserClientId: String {
  guard let client = oauthClients.first(where: { $0.name == "browser" }) else {
    preconditionFailure("No browser OAuth client")
  }
  return client.id
}

private func base64URL(_ bytes: some Sequence<UInt8>) -> String {
  Data(bytes).base64EncodedString()
    .replacingOccurrences(of: "+", with: "-")
    .replacingOccurrences(of: "/", with: "_")
    .replacingOccurrences(of: "=", with: "")
}

private func randomURLSafe(_ count: Int) -> String {
  var random = SystemRandomNumberGenerator()
  return base64URL((0..<count).map { _ in UInt8.random(in: .min ... .max, using: &random) })
}

public func codeChallenge(_ verifier: String) -> String {
  base64URL(SHA256.hash(data: Data(verifier.utf8)))
}

public func beginAuthorization(
  _ options: BeginAuthorizationOptions, storage: any SessionStorage, httpClient: HTTPClient
) async throws -> String {
  let base = try gatewayUrl(options.target)
  let issuer = try await discoverIssuer(base, http: httpClient)
  guard var url = URLComponents(string: issuer.authorization), url.scheme != nil,
    URLComponents(string: options.redirectUri)?.scheme != nil
  else { throw SignInError(.discovery, "Sign-in needs valid authorization and redirect addresses") }
  let record = PendingAuthorization(
    state: randomURLSafe(24), verifier: randomURLSafe(48), redirectUri: options.redirectUri,
    target: options.target, issuer: issuer, kbId: options.kbId, expectedDid: options.expectedDid,
    expectedName: options.expectedName)
  let parameters = [
    ("response_type", "code"),
    ("client_id", browserClientId),
    ("redirect_uri", record.redirectUri),
    ("scope", signInScope.value),
    ("state", record.state),
    ("code_challenge", codeChallenge(record.verifier)),
    ("code_challenge_method", "S256"),
  ].map { key, value in
    "\(key)=\(encodeUriComponent(value))"
  }
  url.percentEncodedQuery = ([url.percentEncodedQuery].compactMap { $0 } + parameters)
    .joined(separator: "&")
  guard let address = url.string else {
    throw SignInError(.discovery, "Invalid authorization address")
  }
  try storage.set(pendingAuthorizationKey, storedText(record))
  return address
}

public func completeAuthorization(
  _ callback: String, storage: any SessionStorage, httpClient: HTTPClient
) async throws -> (pending: PendingAuthorization, session: HeldSignIn) {
  let taken = Mutex<String?>(nil)
  try storage.update(pendingAuthorizationKey) { text in
    taken.withLock { $0 = text }
    return nil
  }
  guard let record = decodedStorage(PendingAuthorization.self, taken.withLock({ $0 })) else {
    throw SignInError(.noPending, "No sign-in is pending here")
  }
  guard let url = URLComponents(string: callback), url.scheme != nil else {
    throw SignInError(.exchange, "The sign-in response is not a URL")
  }
  let query = url.queryItems ?? []
  func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
  if let error = value("error") {
    throw SignInError(
      error == "access_denied" ? .denied : .exchange, value("error_description") ?? error)
  }
  guard value("state") == record.state else {
    throw SignInError(.state, "The sign-in response does not belong to the pending sign-in")
  }
  guard let code = value("code"), !code.isEmpty else {
    throw SignInError(.exchange, "The sign-in response carries no authorization code")
  }
  let answer = try await issuerAnswer(
    record.issuer.token, http: httpClient,
    form: [
      ("grant_type", "authorization_code"), ("code", code), ("redirect_uri", record.redirectUri),
      ("client_id", browserClientId), ("code_verifier", record.verifier),
    ])
  guard answer.status == 200, let access = answer.text("access_token"),
    let refresh = answer.text("refresh_token")
  else {
    throw SignInError(.exchange, "The issuer did not return a session", status: answer.status)
  }
  return (
    record,
    HeldSignIn(
      access: access, clientId: browserClientId, refresh: refresh,
      revocationEndpoint: record.issuer.revocation, tokenEndpoint: record.issuer.token)
  )
}

public struct ConnectionIdentity: Sendable {
  public let did: UserId
  public let description: KbDescription
}

public struct IdentityUnverifiableError: Error, Sendable, CustomStringConvertible {
  public let reason: KbIdentityErrorCode
  public let description: String
}

public func describeConnection(
  _ target: HttpEndpoint, access: String, httpClient: HTTPClient,
  timing: TransportTiming = TransportTiming()
) async throws -> ConnectionIdentity {
  let description: KbDescription
  do {
    let base = try gatewayUrl(target)
    let operation = Operations.browseKbRequested
    let transport = HttpTransport(
      baseUrl: base, httpClient: httpClient, token: access,
      channels: [operation.result.name, operation.failure.name], timing: timing)
    defer { transport.dispose() }
    description = try await Bus(transport).request(operation, BrowseKbRequest()).response
  } catch let refusal as BusRequestError where refusal.reason == .busRejected {
    throw IdentityUnverifiableError(reason: .notReported, description: refusal.description)
  } catch is CancellationError {
    throw CancellationError()
  } catch {
    throw IdentityUnverifiableError(reason: .unreachable, description: String(describing: error))
  }
  do {
    return try ConnectionIdentity(did: kbDid(description.domain), description: description)
  } catch {
    throw IdentityUnverifiableError(reason: .notReported, description: String(describing: error))
  }
}
