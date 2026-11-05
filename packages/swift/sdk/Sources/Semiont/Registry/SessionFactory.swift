import AsyncHTTPClient

public struct SessionFactoryOptions: Sendable {
  public let kb: KnowledgeBase
  public let storage: any SessionStorage
  public let signals: SessionSignals
  public let onError: @Sendable (any Error) -> Void
}

public protocol SessionFactory: Sendable {
  func session(_ options: SessionFactoryOptions) async throws -> OpenedSession
  func revoke(_ session: HeldSignIn) async
}

public struct HttpSessionFactory: SessionFactory {
  private let httpClient: HTTPClient

  public init(httpClient: HTTPClient) { self.httpClient = httpClient }

  public func session(_ options: SessionFactoryOptions) async throws -> OpenedSession {
    let kb = options.kb
    return try await sessionFromKept(
      kb: KbTarget(endpoint: kb.endpoint, id: kb.id, label: kb.label),
      kept: keptIn(options.storage, kbId: kb.id), httpClient: httpClient,
      onAuthFailed: options.signals.notifySessionEnded, onError: options.onError,
      persistence: CachePersistence(storage: options.storage, keyPrefix: kb.id))
  }

  public func revoke(_ session: HeldSignIn) async {
    guard let url = session.revocationEndpoint else { return }
    _ = try? await issuerAnswer(
      url, http: httpClient,
      form: [
        ("client_id", session.clientId), ("token", session.refresh),
        ("token_type_hint", "refresh_token"),
      ])
  }
}
