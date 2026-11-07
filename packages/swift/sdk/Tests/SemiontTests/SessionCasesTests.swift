import Foundation
import SemiontTesting
import Synchronization
import Testing

@testable import Semiont

private actor SessionScript {
  let kept: MemorySignIn
  let issuer: [String]
  let gateway: [String]
  var asks = 0
  var renewals = 0
  init(kept: MemorySignIn, issuer: [String], gateway: [String]) {
    self.kept = kept
    self.issuer = issuer
    self.gateway = gateway
  }
  func renew(_ holding: String?) async throws -> String? {
    let reply = issuer[min(renewals, issuer.count - 1)]
    renewals += 1
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
        kb: target(), client: try await SemiontClient(transport: ProbeTransport(), clock: clock),
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
  let session = SemiontSession(
    kb: target(), client: try await SemiontClient(transport: ProbeTransport()), kept: kept,
    forget: { await kept.forget() },
    renew: { _ in
      calls.withLock { $0 += 1 }
      try await Task.sleep(for: .milliseconds(80))
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
  try await Task.sleep(for: .milliseconds(10))
  first.cancel()
  let second = try await session.refresh(token)
  #expect(second == "new-token")
  #expect(calls.withLock { $0 } == 1)
  await #expect(throws: CancellationError.self) { try await first.value }
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
@Test func disposingASessionCancelsRenewalAndFinishesItsReaders() async throws {
  let access = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let kept = MemorySignIn(
    HeldSignIn(
      access: access, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer"))
  let entered = Watched(false)
  let session = SemiontSession(
    kb: target(), client: try await SemiontClient(transport: ProbeTransport()), kept: kept,
    forget: { await kept.forget() },
    renew: { _ in
      entered.set(true)
      try await Task.sleep(for: .milliseconds(10_000))
      return "late-token"
    },
    validate: { _ in
      try UserResponse(
        did: UserId("did:web:kb:users:alice"), domain: "kb", email: nil, image: nil, name: nil)
    }, random: RandomSource(SystemRandomNumberGenerator()))
  await session.start()
  try await session.ready()
  let renewing = Task { try await session.refresh(session.token.value) }
  try await withinTestDeadline { for await value in entered where value { return } }
  session.dispose()
  session.dispose()
  await #expect(throws: CancellationError.self) {
    try await withinTestDeadline { try await renewing.value }
  }
  #expect(session.token.value == access)
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
    kb: target(), client: try await SemiontClient(transport: ProbeTransport()), kept: kept,
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
    kb: target(), client: try await SemiontClient(transport: ProbeTransport()), kept: kept,
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
    kb: target(), client: try await SemiontClient(transport: ProbeTransport()), kept: kept,
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
@Test func changingCredentialsCannotMakeStartupAskForeverAndItsCallbackHearsTheFailure()
  async throws
{
  let access = try jwt(.object(["exp": .number(Date().timeIntervalSince1970 + 3600)]))
  let kept = MemorySignIn(
    HeldSignIn(
      access: access, clientId: scriptClientID, refresh: "refresh", tokenEndpoint: "issuer"))
  let gate = SessionGate()
  let asks = Mutex(0)
  let renewals = Mutex(0)
  let errors = Mutex<[String]>([])
  let session = SemiontSession(
    kb: target(), client: try await SemiontClient(transport: ProbeTransport()), kept: kept,
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
    random: RandomSource(SystemRandomNumberGenerator()),
    onError: { error in errors.withLock { $0.append(error.code) } })
  defer { session.dispose() }
  await gate.set(session)
  await session.start()
  try await withinTestDeadline { try await session.ready() }
  #expect(asks.withLock { $0 } == 2)
  #expect(session.user.value == nil)
  #expect(errors.withLock { $0 } == ["session.auth-failed"])
}
