import Foundation
import SemiontTesting
import Synchronization
import Testing

@testable import Semiont

// How a registry reads the errors of each session it activates, against
// protocol/specs/src/session/registry-errors-cases.json: as their one reader, from the first thing
// the session said, over a factory that reads none of them. A case's session is a script's, which
// says what the case says on its errors; a closing case's is the registry's own, over a gateway in
// this process, whose client keeps in a storage that refuses every write once the registry closes
// (closeARegistry).

private func registryErrorsTable() throws -> [String: JSONValue] {
  try Spec.read("session/registry-errors-cases.json").object
}

/// One thing a case's session says on its errors.
private enum Said: Sendable {
  /// One of its own errors, by its code.
  case own(SessionErrorCode)
  /// A failure of its transport, by its code, with its message.
  case transport(TransportErrorCode, message: String)

  init(_ value: JSONValue) throws {
    let said = try value.object
    if let own = said["own"] {
      let text = try own.text
      guard let code = SessionErrorCode(rawValue: text) else {
        throw SpecFailure.shape("\(text) is no code of a session's own errors")
      }
      self = .own(code)
      return
    }
    let text = try required(said, "transport").text
    guard let code = TransportErrorCode(rawValue: text) else {
      throw SpecFailure.shape("\(text) is no code of a transport's failures")
    }
    self = .transport(code, message: try required(said, "message").text)
  }

  var own: SessionErrorCode? {
    guard case .own(let code) = self else { return nil }
    return code
  }

  /// Says it on `session`'s errors.
  func say(on session: SemiontSession) {
    switch self {
    case .own(let code):
      session.failed(SessionError(code, "said by the case", kbId: session.kb.id))
    case .transport(let code, let message): session.relay(TransportError(code, message))
    }
  }
}

/// What the registry said, by its code: one of a session's own errors by its code, and anything
/// else as it describes itself, which no case's `registryErrors` holds.
private func registryCode(_ error: any Error) -> String {
  guard let own = error as? SessionError else { return String(describing: error) }
  return own.code
}

/// A registry's sessions, each over a scripted transport that answers a read of the knowledge base
/// as its entry and refuses all else, and over the sign-in the registry keeps for it. Each says
/// `opening` as it is built, before it is handed back; each renewal records the token it is
/// handed, and renews the sign-in with `renewal`. It reads none of a session's errors, and revokes
/// nothing: no case signs out.
private final class SayingSessions: SessionFactory {
  private let opening: [Said]
  private let renewal: String
  private let handed = Mutex<[String?]>([])

  init(opening: [Said], renewal: String) {
    self.opening = opening
    self.renewal = renewal
  }

  /// The token each renewal was handed, in the order they were asked for.
  var renewalsHanded: [String?] { handed.withLock { $0 } }

  func session(_ options: SessionFactoryOptions) async throws -> OpenedSession {
    let kb = options.kb
    let kept = keptIn(options.storage, kbId: kb.id)
    let transport = ScriptedTransport(channels: bridgedChannels) { operation, _ in
      guard operation == Channels.browseKbRequested.name else {
        throw BusRequestError(.busRejected, "Unread")
      }
      return try wirePayload(
        BrowseKbResult(response: KbDescription(domain: "example.org", name: "KB")))
    }
    let opened = try await createTestSession(
      TestSessionOptions(
        kb: KbTarget(endpoint: kb.endpoint, id: kb.id, label: kb.label), kept: kept,
        transport: transport,
        renew: { [self] holding in
          handed.withLock { $0.append(holding) }
          guard let read = try await kept.held() else { return nil }
          return try await kept.renewed(read: read, access: renewal, refresh: read.refresh)
        }, onAuthFailed: options.signals.notifySessionEnded)
    ).opened
    for said in opening { said.say(on: opened.session) }
    return opened
  }

  func revoke(_ session: HeldSignIn) async {}
}

/// Waits for what the registry does with the last thing a case's session `said`: says it on its
/// errors, when it is one of the session's own; hands a renewal a token, for a refusal for want of
/// a valid token; or says a refusal with its message through `signals`, for a refusal for lack of
/// permission. Gives the codes the registry said on `errors` up to then.
private func saidUntilTheLastIsRead(
  _ said: [Said], errors: Events<any Error>, sessions: SayingSessions, signals: SessionSignals
) async throws -> [String] {
  guard let last = said.last else { throw SpecFailure.shape("the session says nothing") }
  switch last {
  case .own(let code):
    let count = said.filter { $0.own == code }.count
    var codes: [String] = []
    var heard = 0
    for try await error in errors {
      codes.append(registryCode(error))
      if (error as? SessionError)?.reason == code { heard += 1 }
      if heard == count { return codes }
    }
    throw SpecFailure.shape("the registry's errors ended before \(code.rawValue) was said")
  case .transport(.unauthorized, _):
    while sessions.renewalsHanded.isEmpty { try await Task.sleep(for: .milliseconds(1)) }
  case .transport(.forbidden, let message):
    guard await signals.permissionDenied.contains(where: { $0?.detail == message }) else {
      throw SpecFailure.shape("the refusal \(message) was never said through the signals")
    }
  case .transport(let code, _):
    throw SpecFailure.shape("the registry does nothing with \(code.rawValue) to wait for")
  }
  // What the registry said before then is what it has given `errors`: ended, they give it all.
  errors.dispose()
  var codes: [String] = []
  for try await error in errors { codes.append(registryCode(error)) }
  return codes
}

@Test func aRegistryReadsEachSessionsErrorsAsTheRegistryErrorsCasesSay() async throws {
  let cases = try required(registryErrorsTable(), "cases").array
  #expect(!cases.isEmpty, "session/registry-errors-cases.json holds cases")
  let hour = Date().timeIntervalSince1970 + 3600
  let held = try jwt(.object(["exp": .number(hour), "name": .string("held")]))
  let renewal = try jwt(.object(["exp": .number(hour), "name": .string("renewal")]))
  for value in cases {
    let row = try value.object
    let why = try required(row, "why").text
    let said = try required(row, "said").array.map(Said.init)
    let phase = try required(row, "while").text
    guard phase == "opening" || phase == "active" else {
      throw SpecFailure.shape("\(why): while \(phase)")
    }
    let registryErrors = try required(row, "registryErrors").array.map { try $0.text }
    let renewed: Bool
    switch try row["renewedWith"].map({ try $0.text }) {
    case nil: renewed = false
    case "held"?: renewed = true
    case .some(let other): throw SpecFailure.shape("\(why): renewedWith \(other)")
    }
    let permissionDenied = try row["permissionDenied"].map { try $0.text }

    let sessions = SayingSessions(opening: phase == "opening" ? said : [], renewal: renewal)
    let browser = try await newSemiontBrowser(
      SemiontBrowserConfig(storage: MemorySessionStorage(), sessionFactory: sessions))
    let errors = browser.errors()
    do {
      _ = try await browser.signedIn(
        SignedIn(
          endpoint: .httpEndpoint(HttpEndpoint(host: "localhost", port: 4000, protocol: .http)),
          description: KbDescription(domain: "example.org", name: "KB"),
          session: HeldSignIn(
            access: held, clientId: "browser", refresh: "refresh", tokenEndpoint: "issuer")))
      let opened = try #require(browser.activeSession.value, "\(why): no session is active")
      let signals = try #require(browser.activeSignals.value, "\(why): no session is active")
      if phase == "active" {
        for one in said { one.say(on: opened.session) }
      }
      let codes = try await withinTestDeadline {
        try await saidUntilTheLastIsRead(
          said, errors: errors, sessions: sessions, signals: signals)
      }
      #expect(codes == registryErrors, "\(why)")
      if renewed {
        let first = try await withinTestDeadline { () async throws -> String? in
          while true {
            if let first = sessions.renewalsHanded.first { return first }
            try await Task.sleep(for: .milliseconds(1))
          }
        }
        #expect(first == held, "\(why): the renewal was handed another token than the one held")
      } else {
        #expect(sessions.renewalsHanded.isEmpty, "\(why): handed \(sessions.renewalsHanded)")
      }
      if let permissionDenied {
        #expect(signals.permissionDenied.value?.detail == permissionDenied, "\(why)")
      } else {
        #expect(
          signals.permissionDenied.value == nil,
          "\(why): \(String(describing: signals.permissionDenied.value))")
      }
    } catch {
      try? await browser.close()
      throw error
    }
    // What its close raises is no case's to say.
    try? await browser.close()
  }
}

@Test func aRegistrysCloseReadsItsActiveSessionsErrorsAsTheRegistryErrorsCasesSay() async throws {
  let rows = try required(registryErrorsTable(), "closing").array
  #expect(!rows.isEmpty, "session/registry-errors-cases.json holds closing cases")
  for value in rows {
    let row = try value.object
    let why = try required(row, "why").text
    guard case .bool(let owed) = try required(row, "owed") else {
      throw SpecFailure.shape("\(why): owed is neither true nor false")
    }
    let registryErrors = try required(row, "registryErrors").array.map { try $0.text }
    // What its close raises is no case's to say.
    try await closeARegistry(owingASave: owed) { _, said in
      #expect(said.map(registryCode) == registryErrors, "\(why): \(said)")
    }
  }
}
