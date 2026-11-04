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
  do {
    let client = try await SemiontClient(transport: transport, gateway: transport)
    return OpenedSession(session: session, client: client)
  } catch {
    session.dispose()
    transport.dispose()
    throw error
  }
}

public final class OpenedSession: Sendable {
  public let session: SemiontSession
  public let client: SemiontClient
  init(session: SemiontSession, client: SemiontClient) {
    self.session = session
    self.client = client
  }
  public func dispose() {
    session.dispose()
    client.dispose()
  }
  deinit { dispose() }
}
