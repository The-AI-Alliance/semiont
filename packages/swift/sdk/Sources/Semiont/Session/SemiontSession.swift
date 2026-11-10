import Foundation

public enum SessionEndReason: String, Codable, Sendable { case expired, refused }

public actor SemiontSession: StateUnit {
  public nonisolated let id = "session-" + UUID().uuidString
  public nonisolated let kb: KbTarget
  public nonisolated let client: SemiontClient
  public nonisolated let streamState: Watched<ConnectionState>
  public nonisolated let token = Watched<String?>(nil)
  public nonisolated let user = Watched<UserResponse?>(nil)
  nonisolated let lifetime = Lifetime()
  /// Its one errors stream: what it says before anyone reads it is kept for the first reader.
  private nonisolated let failures = Broadcast<any Error>(keepingForFirst: true)
  let kept: any SignInKept
  /// Forgets the sign-in `kept` holds.
  private let forget: @Sendable () async throws -> Void
  private let renew: @Sendable (String?) async throws -> String?
  /// Asks the gateway who a token is: nil for a session that asks nobody.
  private let validate: (@Sendable (String) async throws -> UserResponse)?
  private let publish: @Sendable (String?) async -> Void
  private let onAuthFailed: (@Sendable (SessionEndReason) -> Void)?
  private let reconnectMs: Int
  private let random: RandomSource
  private let timer: @Sendable (Duration) -> @Sendable () async throws -> Void
  private var starting: Task<Void, any Error>?
  private var renewal: Task<String?, any Error>?
  private var validation: (String?, Task<String?, any Error>)?
  /// The token it last held, or found stored at its start: what a renewal is handed while it holds
  /// none.
  private var lastHeld: String?
  private var readyState = false
  private var unanswered = false
  private var retryCap: Int
  private var scheduled: UUID?
  package init(
    kb: KbTarget, client: SemiontClient, kept: any SignInKept,
    forget: @escaping @Sendable () async throws -> Void,
    renew: @escaping @Sendable (String?) async throws -> String?,
    validate: (@Sendable (String) async throws -> UserResponse)?,
    publish: @escaping @Sendable (String?) async -> Void = { _ in },
    reconnectMs: Int = Timings.reconnectMs, random: RandomSource,
    onAuthFailed: (@Sendable (SessionEndReason) -> Void)? = nil
  ) {
    self.kb = kb
    self.client = client
    self.streamState = client.state
    self.kept = kept
    self.forget = forget
    self.renew = renew
    self.validate = validate
    self.publish = publish
    self.reconnectMs = reconnectMs
    self.random = random
    let clock = client.clock
    timer = { delay in
      // Measure the delay from scheduling, even if the task starts later.
      let scheduled = stopwatch(clock)
      return { try await clock.sleep(for: delay - scheduled()) }
    }
    self.retryCap = reconnectMs
    self.onAuthFailed = onAuthFailed
    let token = token
    let user = user
    lifetime.onEnd {
      token.finish(with: token.value)
      user.finish(with: user.value)
    }
  }
  deinit {
    lifetime.end()
    failures.finish()
  }
  /// Ends the session at once, and its errors once every write its client has begun has landed:
  /// what its client's closing flush says is said on them before they end.
  public nonisolated func dispose() {
    lifetime.end()
    Task { [self] in
      await client.closed()
      failures.finish()
    }
  }
  nonisolated func failed(_ error: SessionError) { failures.yield(error) }
  nonisolated func relay(_ error: any Error) { failures.yield(error) }
  public nonisolated func errors() -> Events<any Error> { failures.listen() }
  public nonisolated func expiresAt() -> Double? { token.value.flatMap(tokenExpiry) }
  package func start() {
    precondition(starting == nil, "A session starts once")
    let id = UUID()
    let life = lifetime
    let task = Task { [self] in
      defer {
        life.forget(id)
        readyState = true
      }
      try await begin()
    }
    starting = task
    life.keep(task, id: id)
  }
  public func ready() async throws {
    guard let starting else { preconditionFailure("Session not started") }
    _ = try await sharedValue(starting, lifetime: lifetime)
  }
  /// The gateway refused `refused`, the token a request carried (nil when it carried none): renew it,
  /// and ask the gateway who the new one is. A caller that wants the token renewed passes the token
  /// the session holds. A token the session no longer holds was answered already: the token it holds
  /// is given, and nothing is renewed or asked.
  public func refresh(_ refused: String?) async throws -> String? {
    guard !lifetime.ended else { throw CancellationError() }
    if token.value != refused { return token.value }
    if let (credential, task) = validation, credential == refused {
      return try await sharedValue(task, lifetime: lifetime)
    }
    let id = UUID()
    let task = Task<String?, any Error> { [self] in
      defer {
        lifetime.forget(id)
        validation = nil
      }
      guard let renewed = try await renewed(), readyState, let validate else { return token.value }
      do {
        let named = try await validate(renewed)
        if !lifetime.ended, token.value == renewed { user.set(named) }
      } catch let failure as TransportError where failure.reason == .unauthorized {
        if token.value == renewed { try await signedOut(.refused, code: .sessionCredentialRefused) }
      } catch {
        if Task.isCancelled { throw CancellationError() }
        // The gateway has refused nothing: the renewed token remains usable.
      }
      return token.value
    }
    validation = (refused, task)
    lifetime.keep(task, id: id)
    return try await sharedValue(task, lifetime: lifetime)
  }
  private func setToken(_ value: String?) async {
    guard !lifetime.ended else { return }
    if let value { lastHeld = value }
    token.set(value)
    await publish(value)
  }
  /// Renews the token it holds, or, holding none, the one it last held. Only the issuer's refusal
  /// forgets the sign-in; a renewal that gets no answer, whatever failed, leaves the session no
  /// token, says so (`session.auth-failed` at the start, `session.refresh-exhausted` later) and
  /// renews again on the reconnect backoff.
  private func renewed(startup: Bool = false) async throws -> String? {
    if let renewal { return try await sharedValue(renewal, lifetime: lifetime) }
    let holding = token.value ?? lastHeld
    let id = UUID()
    let task = Task<String?, any Error> { [self] in
      defer {
        lifetime.forget(id)
        renewal = nil
      }
      do {
        if let next = try await renew(holding) {
          try Task.checkCancellation()
          unanswered = false
          retryCap = reconnectMs
          await setToken(next)
          schedule()
          return next
        }
        try Task.checkCancellation()
        guard try await kept.held() != nil else {
          await setToken(nil)
          return nil
        }
      } catch let failure as SignInError where refusedAtIssuer(failure) {
        if Task.isCancelled { throw CancellationError() }
      } catch {
        if Task.isCancelled { throw CancellationError() }
        await setToken(nil)
        unanswered = true
        failed(
          SessionError(
            startup ? .sessionAuthFailed : .sessionRefreshExhausted,
            "The token was not renewed: " + String(describing: error), kbId: kb.id))
        schedule()
        return nil
      }
      // The issuer refused it, or its renewal gave nothing while the sign-in is still kept.
      if startup {
        await setToken(nil)
        try await forget()
      } else {
        try await signedOut(.expired, code: .sessionRefreshExhausted)
      }
      return nil
    }
    renewal = task
    lifetime.keep(task, id: id)
    return try await sharedValue(task, lifetime: lifetime)
  }
  private func signedOut(_ reason: SessionEndReason, code: SessionErrorCode) async throws {
    unanswered = false
    if let scheduled {
      lifetime.cancel(scheduled)
      self.scheduled = nil
    }
    await setToken(nil)
    if !lifetime.ended { user.set(nil) }
    var why = "Session ended: " + reason.rawValue
    do { try await forget() } catch {
      why += "; and the sign-in could not be forgotten: \(error)"
    }
    guard !lifetime.ended else { return }
    onAuthFailed?(reason)
    failed(SessionError(code, why, kbId: kb.id))
  }
  private func begin() async throws {
    guard let found = try await kept.held() else { return }
    var credential = found.access
    lastHeld = credential
    var justIssued = isTokenExpired(credential, now: Date().timeIntervalSince1970)
    if justIssued {
      guard let next = try await renewed(startup: true) else { return }
      credential = next
    } else {
      await setToken(credential)
      schedule()
    }
    guard let validate else { return }
    var asks = 0
    while !lifetime.ended && asks < 2 {
      asks += 1
      do {
        let named = try await validate(credential)
        guard !lifetime.ended else { throw CancellationError() }
        if token.value != credential {
          guard let next = token.value else { return }
          credential = next
          justIssued = true
          continue
        }
        user.set(named)
        return
      } catch let failure as TransportError where failure.reason == .unauthorized {
        if token.value != credential {
          guard let next = token.value else { return }
          credential = next
          justIssued = true
          continue
        }
        if justIssued {
          try await signedOut(.refused, code: .sessionCredentialRefused)
          return
        }
        guard let next = try await renewed() else { return }
        credential = next
        justIssued = true
      } catch {
        if Task.isCancelled { throw CancellationError() }
        failed(
          SessionError(
            .sessionAuthFailed, "The gateway did not confirm the credential", kbId: kb.id))
        return
      }
    }
    if !lifetime.ended {
      failed(SessionError(.sessionAuthFailed, "The credential changed during startup", kbId: kb.id))
    }
  }
  private func schedule() {
    if let scheduled { lifetime.cancel(scheduled) }
    guard !lifetime.ended else { return }
    let delay: Int
    if unanswered {
      delay = equalJitter(retryCap, from: random)
      retryCap = min(retryCap * 2, Timings.maxReconnectMs)
    } else if let credential = token.value,
      let due = refreshDelay(credential, now: Date().timeIntervalSince1970),
      due < Double(Int.max / 1000)
    {
      delay = Int(due * 1000)
    } else {
      scheduled = nil
      return
    }
    let wait = timer(.milliseconds(delay))
    let id = UUID()
    let life = lifetime
    let task = Task { [weak self] in
      defer { life.forget(id) }
      do {
        try await wait()
        guard !life.ended, let self else { return }
        try await self.due()
      } catch is CancellationError {} catch { self?.relay(error) }
    }
    scheduled = id
    life.keep(task, id: id)
  }
  private func due() async throws {
    scheduled = nil
    if unanswered, user.value == nil {
      _ = try await refresh(nil)
    } else {
      _ = try await renewed()
    }
  }
}

/// Whether the issuer refused a renewal: an answer the `refresh` rule of
/// protocol/specs/src/retry/cases.json does not try again.
private func refusedAtIssuer(_ failure: SignInError) -> Bool {
  guard failure.reason == .exchange, let status = failure.status else { return false }
  return !RetryContext.refresh.retryable(status: status, method: "POST", keyed: false)
}
