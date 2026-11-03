import AsyncHTTPClient
import Foundation

/// The transport can ask before construction finishes; every waiter belongs to its lifetime.
actor SessionGate {
  private weak var session: SemiontSession?
  private let installed = Watched(false)
  func set(_ session: SemiontSession) {
    self.session = session
    installed.set(true)
  }
  func refresh(_ refused: String?) async throws -> String? {
    for await ready in installed {
      try Task.checkCancellation()
      if ready { return try await session?.refreshOf(refused) }
    }
    throw CancellationError()
  }
}
public func sessionFromKept(
  kb: KbTarget, kept: any SignInKept, httpClient: HTTPClient,
  onAuthFailed: (@Sendable (SessionEndReason) -> Void)? = nil,
  onError: (@Sendable (any Error) -> Void)? = nil
) async throws -> OpenedSession {
  try Task.checkCancellation()
  guard case .httpEndpoint(let endpoint) = kb.endpoint else {
    throw SignInError(.discovery, "A session needs an HTTP endpoint")
  }
  let base = try gatewayUrl(endpoint)
  let found = try await kept.held()
  try Task.checkCancellation()
  let gate = SessionGate()
  let transport = HttpTransport(
    baseUrl: base, httpClient: httpClient,
    token: found.flatMap {
      isTokenExpired($0.access, now: Date().timeIntervalSince1970) ? nil : $0.access
    }, refresher: { try await gate.refresh($0) })
  let session = SemiontSession(
    kb: kb, kept: kept, streamState: transport.state,
    renew: { try await renewKept(kept, holding: $0, httpClient: httpClient) },
    validate: { try await whoAmI(baseUrl: base, token: $0, httpClient: httpClient) },
    publish: { await transport.setToken($0) }, onAuthFailed: onAuthFailed, onError: onError)
  let failures = transport.failures()
  let id = UUID()
  let life = session.lifetime
  let forwarding = Task { [weak session] in
    defer { life.forget(id) }
    do { for try await error in failures { session?.report(error) } } catch {
      if !Task.isCancelled { session?.report(error) }
    }
  }
  life.keep(forwarding, id: id)
  await gate.set(session)
  await session.start()
  return OpenedSession(session: session, transport: transport)
}

public final class OpenedSession: Sendable {
  public let session: SemiontSession
  let transport: HttpTransport
  init(session: SemiontSession, transport: HttpTransport) {
    self.session = session
    self.transport = transport
  }
  public func dispose() {
    session.dispose()
    transport.dispose()
  }
  deinit { dispose() }
}
