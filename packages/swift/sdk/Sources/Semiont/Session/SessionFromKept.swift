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
      if ready { return try await session?.refresh(refused) }
    }
    throw CancellationError()
  }
  func report(_ error: any Error) { session?.report(error) }
}
/// A session with the knowledge base `kb`, over the sign-in `kept` holds. Given a `storage`, its
/// client keeps its persisted queries' answers there for the person the gateway says the token
/// is, once `kept` records them (``SignInKept/recordPersonKey(holding:_:)``), and from the start
/// when it names them already. Before each write it asks `kept` whether the sign-in still names
/// that person, and once it does not (forgotten, or another sign-in kept in its place), or `kept`
/// cannot say, the client writes nothing more; that `kept` could not say is reported once, as a
/// ``SessionError`` of `session.keep-failed`. Over the sign-in a registry keeps there
/// (``keptIn(_:kbId:)``), forgetting the saved sign-in deletes what was kept of its person, and
/// nothing the client was writing lands after the session's own forgetting of it.
public func sessionFromKept(
  kb: KbTarget, kept: any SignInKept, httpClient: HTTPClient,
  onAuthFailed: (@Sendable (SessionEndReason) -> Void)? = nil,
  onError: (@Sendable (any Error) -> Void)? = nil, storage: (any SessionStorage)? = nil,
  clock: any Clock<Duration> = ContinuousClock(),
  random: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator()
) async throws -> OpenedSession {
  try Task.checkCancellation()
  guard case .httpEndpoint(let endpoint) = kb.endpoint else {
    throw SignInError(.discovery, "A session needs an HTTP endpoint")
  }
  let base = try gatewayUrl(endpoint)
  let found = try await kept.held()
  try Task.checkCancellation()
  let gate = SessionGate()
  let draws = RandomSource(random)
  let transport = HttpTransport(
    baseUrl: base, httpClient: httpClient,
    token: found.flatMap {
      isTokenExpired($0.access, now: Date().timeIntervalSince1970) ? nil : $0.access
    }, clock: clock, random: draws, refresher: { try await gate.refresh($0) })
  let failures = transport.failures()
  let writer = WritesWhileNamed(kept: kept, report: { await gate.report($0) })
  let persistence = storage.map {
    CachePersistence(storage: $0, kbId: kb.id, person: found?.personKey, writer: writer)
  }
  let client: SemiontClient
  do {
    client = try await SemiontClient(
      transport: transport, gateway: transport, persistence: persistence, clock: clock)
  } catch {
    failures.dispose()
    transport.dispose()
    throw error
  }
  let session = SemiontSession(
    kb: kb, client: client, kept: kept,
    forget: { try await writer.forgetting { try await kept.forget() } },
    renew: {
      try await renewKept(kept, holding: $0, httpClient: httpClient, clock: clock, random: draws)
    },
    validate: { token in
      let user = try await whoAmI(
        baseUrl: base, token: token, httpClient: httpClient, clock: clock)
      guard persistence != nil else { return user }
      // Recorded on the sign-in that holds the token asked about, or not at all.
      let person = personKey(user.did)
      do {
        if try await kept.recordPersonKey(holding: token, person) { await client.attach(person) }
      } catch {
        await gate.report(error)
      }
      return user
    },
    publish: { await transport.setToken($0) }, random: draws, onAuthFailed: onAuthFailed,
    onError: onError)
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
  return OpenedSession(session: session)
}

public final class OpenedSession: Sendable {
  public let session: SemiontSession
  public var client: SemiontClient { session.client }

  package init(session: SemiontSession) {
    self.session = session
  }

  public func dispose() {
    session.dispose()
    client.dispose()
  }

  deinit { dispose() }
}
