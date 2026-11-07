import Foundation
import Semiont

public struct TestSessionOptions: Sendable {
  public let kb: KbTarget
  public let kept: any SignInKept
  public let transport: ScriptedTransport
  let random: RandomSource
  public let validate: @Sendable (String) async throws -> UserResponse
  public let renew: @Sendable (String?) async throws -> String?
  public let onAuthFailed: (@Sendable (SessionEndReason) -> Void)?
  public let onError: (@Sendable (SessionError) -> Void)?

  public init(
    kb: KbTarget, kept: any SignInKept = MemorySignIn(),
    transport: ScriptedTransport = ScriptedTransport(),
    random: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator(),
    validate: @escaping @Sendable (String) async throws -> UserResponse = { _ in
      UserResponse(
        did: try personDid("localhost", "test"), domain: "localhost", email: nil, image: nil,
        name: nil)
    },
    renew: @escaping @Sendable (String?) async throws -> String? = { _ in nil },
    onAuthFailed: (@Sendable (SessionEndReason) -> Void)? = nil,
    onError: (@Sendable (SessionError) -> Void)? = nil
  ) {
    self.kb = kb
    self.kept = kept
    self.transport = transport
    self.random = RandomSource(random)
    self.validate = validate
    self.renew = renew
    self.onAuthFailed = onAuthFailed
    self.onError = onError
  }
}

public struct TestSession: Sendable {
  public let opened: OpenedSession
  public let transport: ScriptedTransport
  public let kept: any SignInKept
}

public func createTestSession(_ options: TestSessionOptions) async throws -> TestSession {
  let client = try await SemiontClient(
    transport: options.transport, clock: options.transport.clock)
  let session = SemiontSession(
    kb: options.kb, client: client, kept: options.kept, renew: options.renew,
    validate: options.validate, random: options.random, onAuthFailed: options.onAuthFailed,
    onError: options.onError)
  await session.start()
  return TestSession(
    opened: OpenedSession(session: session), transport: options.transport, kept: options.kept)
}

public enum Renewal: Sendable {
  case issued(String)
  case refused
  case unavailable
}

/// A registry's session factory with scripted requests, renewals and revocation history.
public actor ScriptedSessions: SessionFactory {
  public typealias Answer =
    @Sendable (String, String, [String: JSONValue]) async throws -> [String: JSONValue]

  private let answer: Answer
  private let clock: any Clock<Duration>
  private let random: RandomSource
  private var renewals: [Renewal] = []
  private var transports: [String: [ScriptedTransport]] = [:]
  public private(set) var revoked: [HeldSignIn] = []
  public private(set) var renewed = 0

  public init(
    clock: any Clock<Duration> = ContinuousClock(),
    random: any RandomNumberGenerator & Sendable = SystemRandomNumberGenerator(),
    answer: @escaping Answer
  ) {
    self.clock = clock
    self.random = RandomSource(random)
    self.answer = answer
  }

  public func queueRenewals(_ outcomes: [Renewal]) { renewals.append(contentsOf: outcomes) }

  public func transports(for kbId: String) -> [ScriptedTransport] { transports[kbId] ?? [] }

  public func session(_ options: SessionFactoryOptions) async throws -> OpenedSession {
    let kb = options.kb
    let answer = answer
    let transport = ScriptedTransport(clock: clock) { operation, payload in
      try await answer(kb.id, operation, payload)
    }
    transports[kb.id, default: []].append(transport)
    let kept = keptIn(options.storage, kbId: kb.id)
    let opened = try await createTestSession(
      TestSessionOptions(
        kb: KbTarget(endpoint: kb.endpoint, id: kb.id, label: kb.label), kept: kept,
        transport: transport, random: random,
        renew: { [weak self] holding in
          guard let self, let read = try await kept.held() else { return nil }
          if read.access != holding,
            !isTokenExpired(read.access, now: Date().timeIntervalSince1970)
          {
            return read.access
          }
          guard let next = try await self.issue() else { return nil }
          return try await kept.renewed(read: read, access: next, refresh: read.refresh)
        }, onAuthFailed: options.signals.notifySessionEnded, onError: options.onError))
    return opened.opened
  }

  private func issue() throws -> String? {
    renewed += 1
    guard !renewals.isEmpty else { return nil }
    switch renewals.removeFirst() {
    case .issued(let token): return token
    case .refused: return nil
    case .unavailable: throw SignInError(.exchange, "The scripted issuer is unavailable")
    }
  }

  public func revoke(_ session: HeldSignIn) { revoked.append(session) }
}
