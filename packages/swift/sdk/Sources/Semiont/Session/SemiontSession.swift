import Foundation

public enum SessionEndReason: String, Codable, Sendable { case expired, refused }

public actor SemiontSession {
  public nonisolated let id = "session-" + UUID().uuidString
  public nonisolated let kb: KbTarget
  public nonisolated let streamState: Watched<ConnectionState>
  public nonisolated let token = Watched<String?>(nil)
  public nonisolated let user = Watched<UserResponse?>(nil)
  nonisolated let lifetime = Lifetime()
  private nonisolated let failures = Broadcast<any Error>()
  let kept: any SignInKept
  private let renew: @Sendable (String?) async throws -> String?
  private let validate: @Sendable (String) async throws -> UserResponse
  private let publish: @Sendable (String?) async -> Void
  private nonisolated let onError: (@Sendable (any Error) -> Void)?
  private let onAuthFailed: (@Sendable (SessionEndReason) -> Void)?
  private let reconnectMs: Int
  private var starting: Task<Void, any Error>?
  private var renewal: Task<String?, any Error>?
  private var validation: (String?, Task<String?, any Error>)?
  private var readyState = false
  private var unanswered = false
  private var retryCap: Int
  private var scheduled: UUID?
  init(
    kb: KbTarget, kept: any SignInKept,
    streamState: Watched<ConnectionState> = Watched(.initial),
    renew: @escaping @Sendable (String?) async throws -> String?,
    validate: @escaping @Sendable (String) async throws -> UserResponse,
    publish: @escaping @Sendable (String?) async -> Void = { _ in },
    reconnectMs: Int = Timings.reconnectMs,
    onAuthFailed: (@Sendable (SessionEndReason) -> Void)? = nil,
    onError: (@Sendable (any Error) -> Void)? = nil
  ) {
    self.kb = kb
    self.streamState = streamState
    self.kept = kept
    self.renew = renew
    self.validate = validate
    self.publish = publish
    self.reconnectMs = reconnectMs
    self.retryCap = reconnectMs
    self.onAuthFailed = onAuthFailed
    self.onError = onError
    let token = token
    let user = user
    let failures = failures
    lifetime.onEnd {
      token.finish(with: token.value)
      user.finish(with: user.value)
      failures.finish()
    }
  }
  deinit { lifetime.end() }
  public nonisolated func dispose() { lifetime.end() }
  nonisolated func report(_ error: any Error) {
    failures.yield(error)
    onError?(error)
  }
  public nonisolated func errors() -> Events<any Error> { failures.listen() }
  public nonisolated func expiresAt() -> Double? { token.value.flatMap(tokenExpiry) }
  func start() {
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
  public func refresh() async throws -> String? { try await refreshOf(token.value) }
  func refreshOf(_ refused: String?) async throws -> String? {
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
      guard let renewed = try await renewed(), readyState else { return token.value }
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
    token.set(value)
    await publish(value)
  }
  private func renewed(startup: Bool = false) async throws -> String? {
    if let renewal { return try await sharedValue(renewal, lifetime: lifetime) }
    let holding = token.value
    let id = UUID()
    let task = Task<String?, any Error> { [self] in
      defer {
        lifetime.forget(id)
        renewal = nil
      }
      do {
        let next = try await renew(holding)
        try Task.checkCancellation()
        if let next {
          unanswered = false
          retryCap = reconnectMs
          await setToken(next)
          schedule()
          return next
        }
        if try await kept.held() != nil {
          if startup {
            try await kept.forget()
            await setToken(nil)
          } else {
            try await signedOut(.expired, code: .sessionRefreshExhausted)
          }
        } else {
          await setToken(nil)
        }
        return nil
      } catch let failure as SignInError {
        if Task.isCancelled { throw CancellationError() }
        await setToken(nil)
        if failure.reason == .exchange, let status = failure.status,
          !RetryContext.refresh.retryable(status: status, method: "POST")
        {
          if startup {
            try await kept.forget()
          } else {
            try await signedOut(.expired, code: .sessionRefreshExhausted)
          }
        } else {
          unanswered = true
          report(
            SessionError(
              startup ? .sessionAuthFailed : .sessionRefreshExhausted,
              "The issuer did not renew the token", kbId: kb.id))
          schedule()
        }
        return nil
      }
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
    do { try await kept.forget() } catch { report(error) }
    guard !lifetime.ended else { return }
    onAuthFailed?(reason)
    report(SessionError(code, "Session ended: " + reason.rawValue, kbId: kb.id))
  }
  private func begin() async throws {
    guard let found = try await kept.held() else { return }
    var credential = found.access
    var justIssued = isTokenExpired(credential, now: Date().timeIntervalSince1970)
    if justIssued {
      guard let next = try await renewed(startup: true) else { return }
      credential = next
    } else {
      await setToken(credential)
      schedule()
    }
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
        report(
          SessionError(
            .sessionAuthFailed, "The gateway did not confirm the credential", kbId: kb.id))
        return
      }
    }
    if !lifetime.ended {
      report(SessionError(.sessionAuthFailed, "The credential changed during startup", kbId: kb.id))
    }
  }
  private func schedule() {
    if let scheduled { lifetime.cancel(scheduled) }
    guard !lifetime.ended else { return }
    let delay: Int
    if unanswered {
      delay = equalJitter(retryCap)
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
    let id = UUID()
    let life = lifetime
    let task = Task { [weak self] in
      defer { life.forget(id) }
      do {
        try await sleepMilliseconds(delay)
        guard !life.ended, let self else { return }
        try await self.due()
      } catch is CancellationError {} catch { self?.report(error) }
    }
    scheduled = id
    life.keep(task, id: id)
  }
  private func due() async throws {
    scheduled = nil
    if unanswered, user.value == nil {
      _ = try await refreshOf(nil)
    } else {
      _ = try await renewed()
    }
  }
}
