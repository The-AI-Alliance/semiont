import AsyncHTTPClient
import Foundation
import Synchronization

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
  func failed(_ error: SessionError) { session?.failed(error) }
}
/// A session with the knowledge base `kb`, over the sign-in `kept` holds. Unless `validate` is
/// false, it asks the gateway who its token is, and so learns the person whose caches its client
/// keeps. Given a `storage`, its client keeps its persisted queries' answers there for the person
/// the gateway says the token is, once `kept` records them (``SignInKept/recordPersonKey(holding:_:)``),
/// and from the start when it names them already. Before each write it asks `kept` whether the
/// sign-in still names that person, and once it does not (forgotten, or another sign-in kept in its
/// place), or `kept` cannot say or cannot record who the gateway named, the client writes nothing
/// more; that `kept` could not is said once on the session's errors, as a ``SessionError`` of
/// `session.keep-failed`. Each write the storage refuses is said there once, as
/// `session.save-refused`, and stays owed. Over the sign-in a registry keeps there
/// (``keptIn(_:kbId:)``), forgetting the saved sign-in deletes what was kept of its person, and
/// nothing the client was writing lands after the session's own forgetting of it.
public func sessionFromKept(
  kb: KbTarget, kept: any SignInKept, httpClient: HTTPClient, validate: Bool = true,
  onAuthFailed: (@Sendable (SessionEndReason) -> Void)? = nil,
  storage: (any SessionStorage)? = nil, clock: any Clock<Duration> = ContinuousClock(),
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
    }, channels: bridgedChannels, clock: clock, random: draws,
    refresher: { try await gate.refresh($0) })
  let writer = WritesWhileNamed(
    kept: kept, report: { code, what in await gate.failed(SessionError(code, what, kbId: kb.id)) })
  let persistence = storage.map {
    CachePersistence(storage: $0, kbId: kb.id, person: found?.personKey, writer: writer)
  }
  let client: SemiontClient
  do {
    client = try await SemiontClient(
      transport: transport, gateway: transport, persistence: persistence, clock: clock)
  } catch {
    transport.dispose()
    throw error
  }
  let asking: (@Sendable (String) async throws -> UserResponse)?
  if validate {
    asking = { token in
      let user = try await whoAmI(
        baseUrl: base, token: token, httpClient: httpClient, clock: clock)
      guard persistence != nil else { return user }
      // Recorded on the sign-in that holds the token asked about, or not at all.
      let person = personKey(user.did)
      if await writer.recorded(person, holding: token) { await client.attach(person) }
      return user
    }
  } else {
    asking = nil
  }
  let session = SemiontSession(
    kb: kb, client: client, kept: kept,
    forget: { try await writer.forgetting { try await kept.forget() } },
    renew: {
      try await renewKept(kept, holding: $0, httpClient: httpClient, clock: clock, random: draws)
    },
    validate: asking, publish: { await transport.setToken($0) }, random: draws,
    onAuthFailed: onAuthFailed)
  await gate.set(session)
  await session.start()
  return OpenedSession(session: session)
}

public final class OpenedSession: Sendable {
  public let session: SemiontSession
  public var client: SemiontClient { session.client }
  /// Its closing, once begun: the client's closing flush, and then the session's end.
  private let closing = Mutex<Task<Void, Never>?>(nil)

  package init(session: SemiontSession) {
    self.session = session
  }

  /// Closes the client and, once its closing flush has written what it held, ends the session:
  /// what that flush meets is said on the session's errors before they end. A renewal of the
  /// session's sign-in under way runs to its end, so what the issuer rotated is kept.
  public func dispose() {
    let session = session
    closing.withLock { closing in
      guard closing == nil else { return }
      session.client.dispose()
      closing = spawn {
        await session.client.closed()
        session.dispose()
        await session.renewalEnded()
      }
    }
  }

  /// Waits until it has closed, once disposed: its client, then its session, and then the renewal
  /// of its sign-in under way, whose rotated tokens are kept by then.
  func closed() async { await closing.withLock { $0 }?.value }

  deinit { dispose() }
}
