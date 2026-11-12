import Foundation
import Synchronization
import Testing

@testable import Semiont
@testable import SemiontTesting

private actor SessionScript {
  let kept: MemorySignIn
  let issuer: [String]
  let gateway: [String]
  var asks = 0
  var renewals = 0
  /// What each renewal was handed, in order.
  var handed: [String?] = []
  init(kept: MemorySignIn, issuer: [String], gateway: [String]) {
    self.kept = kept
    self.issuer = issuer
    self.gateway = gateway
  }
  func renew(_ holding: String?) async throws -> String? {
    let reply = issuer[min(renewals, issuer.count - 1)]
    renewals += 1
    handed.append(holding)
    switch reply {
    case "refuses": throw SignInError(.exchange, "refused", status: 400)
    case "unreachable": throw SignInError(.exchange, "unreachable")
    default:
      let token = try jwt(
        .object([
          "iss": .string("issuer"), "name": .string("renewed"),
          "exp": .number(Date().timeIntervalSince1970 + 3600),
        ]))
      guard let read = await kept.held() else { return nil }
      return await kept.renewed(read: read, access: token, refresh: "renewed")
    }
  }
  func validate(_ token: String) throws -> UserResponse {
    let reply = gateway[min(asks, gateway.count - 1)]
    asks += 1
    switch reply {
    case "refuses": throw TransportError(.unauthorized, "refused", status: 401)
    case "unreachable": throw TransportError(.unavailable, "unreachable")
    default:
      return try UserResponse(
        did: personDid("example.org", textClaim(token, name: "name") ?? "alice"),
        domain: "example.org", email: nil, image: nil, name: textClaim(token, name: "name"))
    }
  }
  func counts() -> (Int, Int) { (asks, renewals) }
}
private func target() -> KbTarget {
  KbTarget(
    endpoint: .httpEndpoint(HttpEndpoint(host: "localhost", port: 4000, protocol: .http)),
    id: "local:test", label: "test")
}
private func status(_ session: SemiontSession) -> String {
  if session.token.value == nil { return "signed-out" }
  return session.user.value == nil ? "unconfirmed" : "signed-in"
}
@Test func sessionRunsEveryStartupAndRefusalCase() async throws {
  let table = try Spec.read("session/cases.json").object
  for part in ["startup", "refusal"] {
    for value in try required(table, part).array {
      let row = try value.object
      let stored = part == "refusal" ? "unexpired" : try required(row, "stored").text
      let access = try jwt(
        .object([
          "iss": .string("issuer"), "name": .string("alice"),
          "exp": .number(Date().timeIntervalSince1970 + (stored == "expired" ? -3600 : 3600)),
        ]))
      let held: HeldSignIn? =
        stored == "none"
        ? nil
        : HeldSignIn(
          access: access, clientId: scriptClientID, refresh: "refresh",
          tokenEndpoint: "http://issuer/token")
      let kept = MemorySignIn(held)
      let gateway = try required(row, "gateway").array.map { try $0.text }
      let script = try SessionScript(
        kept: kept, issuer: required(row, "issuer").array.map { try $0.text },
        gateway: part == "refusal" ? ["accepts"] + gateway : gateway)
      let told = Mutex<[String]>([])
      let errors = Watched<[String]>([])
      let clock = TestClock()
      let reconnectMs = 200
      let session = SemiontSession(
        kb: target(),
        client: try await SemiontClient(
          transport: ProbeTransport(channels: bridgedChannels), clock: clock),
        kept: kept, forget: { await kept.forget() }, renew: { try await script.renew($0) },
        validate: { try await script.validate($0) }, reconnectMs: reconnectMs,
        random: RandomSource(SystemRandomNumberGenerator()),
        onAuthFailed: { reason in told.withLock { $0.append(reason.rawValue) } })
      defer { session.dispose() }
      let events = session.errors()
      let observing = Task {
        for try await error in events {
          if let error = error as? SessionError {
            errors.set(errors.value + [error.code])
          } else {
            Issue.record("Unexpected session error: \(error)")
          }
        }
      }
      await session.start()
      try await session.ready()
      if part == "refusal" {
        let refused: String?
        switch try required(row, "refused").text {
        case "held": refused = session.token.value
        case "replaced":
          refused = try jwt(
            .object([
              "iss": .string("issuer"), "name": .string("replaced"),
              "exp": .number(Date().timeIntervalSince1970 + 3600),
            ]))
        case let said: throw SpecFailure.shape("a refused token the table calls \(said)")
        }
        let given = try await session.refresh(refused)
        #expect((given != nil) == (row["given"] == .bool(true)))
        if let given { #expect(given == session.token.value) }
      }
      let counts = await script.counts()
      #expect(
        counts.0 - (part == "refusal" ? 1 : 0) == Int(try number(required(row, "asks"))),
        "\(row["why"] ?? .null)")
      #expect(counts.1 == Int(try number(required(row, "renewals"))))
      #expect(status(session) == (try required(row, "ends").text))
      #expect((await kept.held() != nil) == (row["kept"] == .bool(true)))
      let expectedTold: [String] =
        if case .string(let reason) = row["told"] { [reason] } else { [] }
      let expectedErrors: [String] =
        if case .string(let error) = row["error"] { [error] } else { [] }
      #expect(told.withLock { $0 } == expectedTold)
      if !expectedErrors.isEmpty {
        try await withinTestDeadline {
          for await seen in errors where seen.count >= expectedErrors.count { return }
          throw CancellationError()
        }
      }
      #expect(errors.value == expectedErrors)
      if let next = row["then"] {
        let expected = try next.object
        let renewals = Int(try number(required(expected, "renewals")))
        let end = try required(expected, "ends").text
        // Move through the first retry window, then leave the clock stopped.
        clock.advance(by: .milliseconds(reconnectMs * 6 / 5))
        try await withinTestDeadline {
          while await script.counts().1 < renewals || status(session) != end {
            try await Task.sleep(for: .milliseconds(1))
          }
        }
        let after = await script.counts()
        #expect(
          after.0 - (part == "refusal" ? 1 : 0) == Int(try number(required(expected, "asks"))),
          "\(row["why"] ?? .null): asks \(after.0)")
        #expect(after.1 == renewals)
        #expect(status(session) == end)
      } else if row["kept"] == .bool(false) {
        clock.advance(by: .milliseconds(reconnectMs * 6 / 5))
        try await Task.sleep(for: .milliseconds(240))
        let after = await script.counts()
        #expect(after == counts)
      }
      // Every renewal is handed the token it renews: the token the row stored, the one its session
      // started on, held or expired, and on the backoff the one whose renewal got no answer.
      let handed = await script.handed
      #expect(
        handed.allSatisfy { $0 == held?.access },
        "\(row["why"] ?? .null): renewals handed \(handed)")
      session.dispose()
      _ = try await observing.value
    }
  }
}
@Test func overlappingRefusalsShareOneRenewalAndCancellingAWaiterKeepsItAlive() async throws {
  let token = try jwt(
    .object(["iss": .string("issuer"), "exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let kept = MemorySignIn(
    HeldSignIn(access: token, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer")
  )
  let calls = Mutex(0)
  let renewing = Watched(false)
  let answered = Watched(false)
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(transport: ProbeTransport(channels: bridgedChannels)),
    kept: kept,
    forget: { await kept.forget() },
    renew: { _ in
      calls.withLock { $0 += 1 }
      renewing.set(true)
      for await given in answered where given { break }
      try Task.checkCancellation()
      return "new-token"
    },
    validate: { _ in
      try UserResponse(
        did: UserId("did:web:test:users:alice"), domain: "test", email: nil, image: nil, name: nil)
    }, random: RandomSource(SystemRandomNumberGenerator()))
  defer { session.dispose() }
  await session.start()
  try await session.ready()
  let first = Task { try await session.refresh(token) }
  try await withinTestDeadline { for await entered in renewing where entered { return } }
  first.cancel()
  await #expect(throws: CancellationError.self) {
    try await withinTestDeadline { try await first.value }
  }
  // The renewal is held until answered, so its only waiter has gone before it can end.
  let second = Task { try await session.refresh(token) }
  answered.set(true)
  #expect(try await withinTestDeadline { try await second.value } == "new-token")
  #expect(calls.withLock { $0 } == 1)
  #expect(try await session.refresh(token) == "new-token")
  #expect(calls.withLock { $0 } == 1)
}
@Test func aRefresherWaitsForItsSessionAndCancelsWhenConstructionEnds() async throws {
  let gate = SessionGate()
  let waiting = Task { try await gate.refresh("token") }
  try await Task.sleep(for: .milliseconds(10))
  waiting.cancel()
  await #expect(throws: CancellationError.self) {
    try await withinTestDeadline { try await waiting.value }
  }
}
@Test func disposingASessionWhileItRenewsKeepsWhatTheIssuerRotatedAndGivesTheRefusalNoToken()
  async throws
{
  let access = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let rotated = "rotated-access"
  let kept = MemorySignIn(
    HeldSignIn(
      access: access, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer"))
  let renewals = Mutex(0)
  let entered = Watched(false)
  let answered = Watched(false)
  let ended = Mutex<[SessionEndReason]>([])
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(transport: ProbeTransport(channels: bridgedChannels)),
    kept: kept,
    forget: { await kept.forget() },
    renew: { _ in
      renewals.withLock { $0 += 1 }
      entered.set(true)
      // The issuer holds its answer until it is released, and then rotates the refresh token.
      for await given in answered where given { break }
      guard let read = await kept.held() else { throw SpecFailure.shape("Nothing is kept") }
      return await kept.renewed(read: read, access: rotated, refresh: "rotated-refresh")
    },
    validate: { _ in
      try UserResponse(
        did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: nil)
    }, random: RandomSource(SystemRandomNumberGenerator()),
    onAuthFailed: { reason in ended.withLock { $0.append(reason) } })
  await session.start()
  try await session.ready()
  let opened = OpenedSession(session: session)
  let renewing = Task { try await session.refresh(access) }
  try await withinTestDeadline { for await value in entered where value { return } }
  opened.dispose()
  opened.dispose()
  let closed = Watched(false)
  let closing = Task {
    await opened.closed()
    closed.set(true)
  }
  // The dispose gives the refusal no token at once, rather than a cancellation it never had, while
  // the issuer still holds its answer and the close waits for it.
  #expect(try await withinTestDeadline { try await renewing.value } == nil)
  #expect(!closed.value)
  #expect(await kept.held()?.refresh == "refresh")
  answered.set(true)
  try await withinTestDeadline { await closing.value }
  // The close returned once the renewal had ended: what the issuer rotated is kept, the ended
  // session took none of it, and nobody was signed out.
  #expect(await kept.held()?.access == rotated)
  #expect(await kept.held()?.refresh == "rotated-refresh")
  #expect(session.token.value == access)
  #expect(ended.withLock { $0 }.isEmpty)
  // A disposed session gives no token, whatever token was refused, and renews nothing.
  #expect(try await session.refresh(access) == nil)
  #expect(try await session.refresh(rotated) == nil)
  #expect(renewals.withLock { $0 } == 1)
  var reader = session.token.makeAsyncIterator()
  #expect(await reader.next() == access)
  #expect(await reader.next() == nil)
}
private struct RefusedWrite: Error, Equatable {}
private struct UnwritableSignIn: SignInKept {
  let entry: HeldSignIn
  func held() async -> HeldSignIn? { entry }
  func keep(_ value: HeldSignIn) async throws { throw RefusedWrite() }
  func renewed(read: HeldSignIn, access: String, refresh: String) async throws -> String? {
    throw RefusedWrite()
  }
  func recordPersonKey(holding access: String, _ personKey: String) async throws -> Bool {
    throw RefusedWrite()
  }
  func forget() async throws { throw RefusedWrite() }
}
@Test func aQuietStartupForgetStillRaisesTheStoresFailure() async throws {
  let access = try jwt(.object(["exp": .number(1)]))
  let kept = UnwritableSignIn(
    entry: HeldSignIn(
      access: access, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer"))
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(transport: ProbeTransport(channels: bridgedChannels)),
    kept: kept,
    forget: { try await kept.forget() },
    renew: { _ in throw SignInError(.exchange, "refused", status: 400) },
    validate: { _ in throw SpecFailure.shape("Must not validate") },
    random: RandomSource(SystemRandomNumberGenerator()))
  defer { session.dispose() }
  await session.start()
  await #expect(throws: RefusedWrite.self) { try await session.ready() }
}
@Test func aRefusalBeforeTheSessionIsInstalledIsAnsweredAfterInstallation() async throws {
  let access = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let kept = MemorySignIn(
    HeldSignIn(
      access: access, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer"))
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(transport: ProbeTransport(channels: bridgedChannels)),
    kept: kept,
    forget: { await kept.forget() }, renew: { _ in "renewed" },
    validate: { _ in
      try UserResponse(
        did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: nil)
    }, random: RandomSource(SystemRandomNumberGenerator()))
  defer { session.dispose() }
  await session.start()
  try await session.ready()
  let gate = SessionGate()
  let waiting = Task { try await gate.refresh(access) }
  try await Task.sleep(for: .milliseconds(10))
  await gate.set(session)
  #expect(try await withinTestDeadline { try await waiting.value } == "renewed")
}
@Test func startupDoesNotPublishTheIdentityOfATokenReplacedWhileItWasAskedAbout() async throws {
  let old = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let kept = MemorySignIn(
    HeldSignIn(access: old, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer"))
  let asked = Watched(false)
  let release = Watched(false)
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(transport: ProbeTransport(channels: bridgedChannels)),
    kept: kept,
    forget: { await kept.forget() }, renew: { _ in "new-token" },
    validate: { token in
      if token == old {
        asked.set(true)
        for await value in release where value { break }
      }
      return try UserResponse(
        did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: token)
    }, random: RandomSource(SystemRandomNumberGenerator()))
  defer {
    session.dispose()
    release.finish(with: true)
  }
  await session.start()
  try await withinTestDeadline { for await value in asked where value { return } }
  #expect(try await session.refresh(old) == "new-token")
  release.set(true)
  try await session.ready()
  #expect(session.user.value?.name == "new-token")
}
/// What `session` says on its errors stream until it ends: each SessionError's code, and anything
/// else as itself.
private func errorsOf(_ session: SemiontSession) -> (Watched<[String]>, Task<Void, any Error>) {
  let said = Watched<[String]>([])
  let errors = session.errors()
  let hearing = Task {
    for try await error in errors {
      if let error = error as? SessionError {
        said.set(said.value + [error.code])
      } else {
        said.set(said.value + ["\(error)"])
      }
    }
  }
  return (said, hearing)
}
@Test func changingCredentialsCannotMakeStartupAskForeverAndItsErrorsSayTheFailure()
  async throws
{
  let access = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let kept = MemorySignIn(
    HeldSignIn(
      access: access, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer"))
  let gate = SessionGate()
  let asks = Mutex(0)
  let renewals = Mutex(0)
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(transport: ProbeTransport(channels: bridgedChannels)),
    kept: kept,
    forget: { await kept.forget() },
    renew: { _ in
      let count = renewals.withLock { count in
        count += 1
        return count
      }
      return "new-token-\(count)"
    },
    validate: { token in
      let count = asks.withLock { count in
        count += 1
        return count
      }
      guard count <= 2 else { throw SpecFailure.shape("Startup was not bounded") }
      _ = try await gate.refresh(token)
      return try UserResponse(
        did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: token)
    },
    random: RandomSource(SystemRandomNumberGenerator()))
  defer { session.dispose() }
  let (said, hearing) = errorsOf(session)
  await gate.set(session)
  await session.start()
  try await withinTestDeadline { try await session.ready() }
  #expect(asks.withLock { $0 } == 2)
  #expect(session.user.value == nil)
  session.dispose()
  try await withinTestDeadline { try await hearing.value }
  #expect(said.value == ["session.auth-failed"])
}

// ── A renewal whose sign-in cannot be read ──────────────────────────────

private struct UnreadableStore: Error {}

/// What holds a sign-in in this process, as `memory` does, except that once `readable` reads of
/// it have been made (nil: no limit) it cannot be read, until it is made readable again.
private final class ReadLimitedSignIn: SignInKept {
  private struct Reads: Sendable {
    var made = 0
    var readable: Int?
  }
  private let memory: MemorySignIn
  private let reads: Mutex<Reads>

  init(_ memory: MemorySignIn, readable: Int?) {
    self.memory = memory
    reads = Mutex(Reads(readable: readable))
  }

  /// Every later read succeeds (true), or fails (false).
  func setReadable(_ value: Bool) {
    reads.withLock { reads in reads.readable = value ? nil : reads.made }
  }

  func held() async throws -> HeldSignIn? {
    let refused = reads.withLock { reads in
      reads.made += 1
      guard let readable = reads.readable else { return false }
      return reads.made > readable
    }
    if refused { throw UnreadableStore() }
    return await memory.held()
  }
  func keep(_ signIn: HeldSignIn) async { await memory.keep(signIn) }
  func renewed(read: HeldSignIn, access: String, refresh: String) async -> String? {
    await memory.renewed(read: read, access: access, refresh: refresh)
  }
  func recordPersonKey(holding access: String, _ personKey: String) async -> Bool {
    await memory.recordPersonKey(holding: access, personKey)
  }
  func forget() async { await memory.forget() }
}

/// When a session renews, as protocol/specs/src/session/cases.json names it: at its start, on its
/// schedule, or when the gateway refuses the token it holds.
private enum Renews: String, CaseIterable, Sendable { case atStart, onSchedule, onRefusal }

// A renewal whose sign-in cannot be read got no answer: it says so on the session's errors, as
// `session.auth-failed` at the start and `session.refresh-exhausted` later, keeps what is stored,
// tells onAuthFailed nothing, and renews again on the reconnect backoff.
@Test func aRenewalWhoseSignInCannotBeReadIsARenewalWithNoAnswer() async throws {
  for when in Renews.allCases {
    do { try await renewsOverAnUnreadableSignIn(when) } catch {
      Issue.record("\(when.rawValue): \(error)")
    }
  }
}

private func renewsOverAnUnreadableSignIn(_ when: Renews) async throws {
  let why = when.rawValue
  let reconnectMs = 200
  let now = Date().timeIntervalSince1970
  // An unexpired token falls due for renewal minRefreshDelayMs after the session starts.
  let claims: [String: JSONValue] =
    when == .atStart
    ? ["exp": .number(now - 3600)] : ["exp": .number(now + 20), "iat": .number(now)]
  let stored = try jwt(.object(claims))
  let memory = MemorySignIn(
    HeldSignIn(
      access: stored, clientId: scriptClientID, refresh: "refresh",
      tokenEndpoint: "http://issuer/token"))
  // The start reads the sign-in once; at the start, the renewal's read is the next.
  let kept = ReadLimitedSignIn(memory, readable: when == .atStart ? 1 : nil)
  let clock = TestClock()
  let renewals = Mutex(0)
  let told = Mutex<[SessionEndReason]>([])
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(
      transport: ProbeTransport(channels: bridgedChannels), clock: clock),
    kept: kept, forget: { await kept.forget() },
    renew: { holding in
      renewals.withLock { $0 += 1 }
      return try await renewKept(kept, holding: holding) { _ in
        IssuedTokens(
          access: try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)])),
          refresh: "renewed")
      }
    },
    validate: { _ in
      try UserResponse(
        did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: nil)
    }, reconnectMs: reconnectMs, random: RandomSource(SystemRandomNumberGenerator()),
    onAuthFailed: { reason in told.withLock { $0.append(reason) } })
  defer { session.dispose() }
  let (said, hearing) = errorsOf(session)
  await session.start()
  // A start whose renewal got no answer has started, with no token.
  try await withinTestDeadline { try await session.ready() }
  switch when {
  case .atStart: #expect(session.token.value == nil, "\(why): a token")
  case .onSchedule:
    kept.setReadable(false)
    clock.advance(by: .milliseconds(Timings.minRefreshDelayMs))
  case .onRefusal:
    kept.setReadable(false)
    let given = try await withinTestDeadline { try await session.refresh(stored) }
    #expect(given == nil, "\(why): a renewal with no answer gives a token")
  }
  let expected = [when == .atStart ? "session.auth-failed" : "session.refresh-exhausted"]
  try await withinTestDeadline {
    for await heard in said where !heard.isEmpty { return }
    throw SpecFailure.shape("The errors ended before anything was said")
  }
  #expect(said.value == expected, "\(why)")
  try await withinTestDeadline {
    for await token in session.token where token == nil { return }
    throw SpecFailure.shape("The token readout ended while the session held a token")
  }
  #expect(await memory.held() != nil, "\(why): the stored sign-in is forgotten")
  #expect(told.withLock { $0 }.isEmpty, "\(why): the session ended")
  // The backoff goes on: the next renewal falls due within reconnectMs, and the sign-in can be
  // read by then.
  kept.setReadable(true)
  let latest = clock.now.advanced(by: .milliseconds(reconnectMs))
  try await withinTestDeadline {
    while !clock.wakes.contains(where: { $0 <= latest }) {
      try await Task.sleep(for: .milliseconds(1))
    }
  }
  clock.advance(by: .milliseconds(reconnectMs * 6 / 5))
  try await withinTestDeadline {
    while renewals.withLock({ $0 }) < 2 { try await Task.sleep(for: .milliseconds(1)) }
  }
  session.dispose()
  try await withinTestDeadline { try await hearing.value }
  #expect(said.value == expected, "\(why): the renewal on the backoff")
}

// ── What a renewal is handed ────────────────────────────────────────────

// A renewal on the reconnect backoff is handed the token whose renewal got no answer, so the kept
// sign-in's renewal asks the issuer for it: handed none, it would give back the kept token, which
// has not expired, and is the one the gateway refused.
@Test func aRenewalOnTheBackoffIsHandedTheTokenTheGatewayRefused() async throws {
  let reconnectMs = 200
  let stored = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let renewed = try jwt(
    .object(["exp": .number(Date().timeIntervalSince1970 + 3600), "name": .string("renewed")]))
  let kept = MemorySignIn(
    HeldSignIn(
      access: stored, clientId: scriptClientID, refresh: "refresh",
      tokenEndpoint: "http://issuer/token"))
  let clock = TestClock()
  let handed = Mutex<[String?]>([])
  let grants = Mutex(0)
  let session = SemiontSession(
    kb: target(),
    client: try await SemiontClient(
      transport: ProbeTransport(channels: bridgedChannels), clock: clock),
    kept: kept, forget: { await kept.forget() },
    renew: { holding in
      handed.withLock { $0.append(holding) }
      return try await renewKept(kept, holding: holding) { _ in
        let grant = grants.withLock { grants in
          grants += 1
          return grants
        }
        // The issuer does not answer the first grant.
        if grant == 1 { throw SignInError(.exchange, "The issuer did not answer") }
        return IssuedTokens(access: renewed, refresh: "renewed")
      }
    },
    validate: { _ in
      try UserResponse(
        did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: nil)
    }, reconnectMs: reconnectMs, random: RandomSource(SystemRandomNumberGenerator()))
  defer { session.dispose() }
  let (said, hearing) = errorsOf(session)
  await session.start()
  try await withinTestDeadline { try await session.ready() }
  // The gateway refuses the token the session holds, and its renewal gets no answer.
  let given = try await withinTestDeadline { try await session.refresh(stored) }
  #expect(given == nil, "a renewal with no answer gives a token")
  let latest = clock.now.advanced(by: .milliseconds(reconnectMs))
  try await withinTestDeadline {
    while !clock.wakes.contains(where: { $0 <= latest }) {
      try await Task.sleep(for: .milliseconds(1))
    }
  }
  clock.advance(by: .milliseconds(reconnectMs * 6 / 5))
  try await withinTestDeadline {
    for await token in session.token where token == renewed { return }
    throw SpecFailure.shape("The token readout ended before the backoff renewed the token")
  }
  #expect(handed.withLock { $0 } == [stored, stored])
  #expect(grants.withLock { $0 } == 2, "the issuer was not asked on the backoff")
  session.dispose()
  try await withinTestDeadline { try await hearing.value }
  #expect(said.value == ["session.refresh-exhausted"])
}

// ── A wait for a token ──────────────────────────────────────────────────

// A wait is for the token it was counted from: one that runs out as a refusal's renewal of that
// token is ending renews nothing, and the renewal's own wait is the one kept. The case runs on one
// thread, and the stored token's wait runs out while the renewed token is published, so that wait
// comes to the session only once the renewal has ended and the renewed token is held.
@Test func aWaitThatRunsOutForATokenARefusalReplacedRenewsNothing() async throws {
  let now = Date().timeIntervalSince1970
  // It falls due minRefreshDelayMs after the session starts.
  let stored = try jwt(.object(["exp": .number(now + 20), "iat": .number(now)]))
  let renewed = try jwt(.object(["exp": .number(now + 3600), "name": .string("renewed")]))
  let kept = MemorySignIn(
    HeldSignIn(
      access: stored, clientId: scriptClientID, refresh: "refresh",
      tokenEndpoint: "http://issuer/token"))
  let clock = TestClock()
  let executor = CaseExecutor()
  defer { executor.stop() }
  try await executor.run {
    let handed = Mutex<[String?]>([])
    let session = SemiontSession(
      kb: target(),
      client: try await SemiontClient(
        transport: ProbeTransport(channels: bridgedChannels), clock: clock),
      kept: kept, forget: { await kept.forget() },
      renew: { holding in
        handed.withLock { $0.append(holding) }
        return renewed
      },
      validate: { _ in
        try UserResponse(
          did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: nil)
      },
      publish: { token in
        if token == renewed { clock.advance(by: .milliseconds(Timings.minRefreshDelayMs)) }
      }, random: RandomSource(SystemRandomNumberGenerator()))
    defer { session.dispose() }
    await session.start()
    try await session.ready()
    await executor.settle()
    #expect(
      clock.wakes.contains(clock.now.advanced(by: .milliseconds(Timings.minRefreshDelayMs))),
      "the stored token's wait is not on the clock")
    #expect(try await session.refresh(stored) == renewed)
    await executor.settle()
    #expect(handed.withLock { $0 } == [stored], "a wait renewed the token a refusal renewed")
    #expect(session.token.value == renewed)
    #expect(clock.strays == 0, "sleeps begun off the case's executor")
  }
}
