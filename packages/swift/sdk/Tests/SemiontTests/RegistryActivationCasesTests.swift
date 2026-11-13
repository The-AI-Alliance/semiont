import Foundation
import Synchronization
import Testing

@testable import Semiont

// How a registry activates a knowledge base, against
// protocol/specs/src/session/registry-activation-cases.json: when its factory refuses the session
// (`refused`), once its close has begun (`closed`), and when another knowledge base's session is
// active (`switching`); and what it says when its factory fails with something that is not one of
// the session's own errors, against protocol/specs/src/session/registry-factory-failure-cases.json.
// Every row's factory records each knowledge base it is asked for a session of, in order, and then
// refuses as the row says or builds the session HttpSessionFactory builds, over a gateway in this
// process (overARegistry). Where a row's first session owes a save, its storage records that
// save's write in the same list: `switching` holds the order of the two to the rule, and `closing`
// holds that write open while kb-b is activated, from within it and from the test.

private func activationTable() throws -> [String: JSONValue] {
  try Spec.read("session/registry-activation-cases.json").object
}

private func factoryFailureTable() throws -> [String: JSONValue] {
  try Spec.read("session/registry-factory-failure-cases.json").object
}

/// What a table says of itself, and not as rows.
private let aboutTheTable: Set<String> = ["$comment", "runBy", "absent", "notYetReached"]

@Test func everySectionOfTheRegistryActivationCasesIsRunHere() throws {
  let sections = Set(try activationTable().keys).subtracting(aboutTheTable)
  #expect(sections == ["refused", "closed", "switching"], "\(sections.sorted())")
}

@Test func everySectionOfTheRegistryFactoryFailureCasesIsRunHere() throws {
  let sections = Set(try factoryFailureTable().keys).subtracting(aboutTheTable)
  #expect(sections == ["cases"], "\(sections.sorted())")
}

/// What a row's factory and its storage were asked, in order.
private final class Steps: Sendable {
  private let taken = Mutex<[String]>([])

  var all: [String] { taken.withLock { $0 } }

  func take(_ step: String) { taken.withLock { $0.append(step) } }
}

private func askedFor(_ kbId: String) -> String { "asked for \(kbId)" }
private let wroteTheOwedSave = "wrote the owed save"

/// A registry's sessions: each knowledge base it is asked for a session of is recorded in `steps`,
/// and then `answer` gives the session, or refuses it. It revokes nothing: no row signs out.
private struct RecordingSessions: SessionFactory {
  let steps: Steps
  let answer: @Sendable (SessionFactoryOptions) async throws -> OpenedSession

  func session(_ options: SessionFactoryOptions) async throws -> OpenedSession {
    steps.take(askedFor(options.kb.id))
    return try await answer(options)
  }

  func revoke(_ session: HeldSignIn) async {}
}

/// One of the session's own errors, by its code and with its message, as a row states it:
/// `{"own": code, "message": text}`.
private func ownError(_ value: JSONValue, kbId: String) throws -> SessionError {
  let own = try value.object
  let text = try required(own, "own").text
  guard let code = SessionErrorCode(rawValue: text) else {
    throw SpecFailure.shape("\(text) is no code of a session's own errors")
  }
  return SessionError(code, try required(own, "message").text, kbId: kbId)
}

/// What a registry said, by its code and its message, as a row's `registryErrors` holds it.
private struct Said: Equatable, Sendable, CustomStringConvertible {
  let code: String
  let message: String

  var description: String { "\(code): \(message)" }

  init(_ value: JSONValue) throws {
    let said = try value.object
    code = try required(said, "code").text
    message = try required(said, "message").text
  }

  init(_ error: SessionError) {
    code = error.code
    message = error.description
  }
}

/// What activating `kbId` ended with: what it was refused with, or nil once it activated.
private func refusal(ofActivating kbId: String, by browser: SemiontBrowser) async -> (any Error)? {
  do {
    try await browser.setActiveKb(kbId)
    return nil
  } catch {
    return error
  }
}

/// No session being active, a registry over a factory that refuses with `refusal` activates kb-a,
/// registered with a sign-in kept for it, as it is made. Gives what the registry said on its errors
/// once that activation has returned. Then no session is active, its factory was asked for one
/// session, and the storage's active key names kb-a.
private func refusedWith(_ refusal: any Error, why: String) async throws -> [Said] {
  let steps = Steps()
  let storage = MemorySessionStorage()
  let kb = KnowledgeBase(
    did: "did:web:kb.example.org",
    endpoint: .httpEndpoint(HttpEndpoint(host: "127.0.0.1", port: 4000, protocol: .http)),
    id: "kb-a", label: "kb-a")
  try saveKnowledgeBases(storage, knowledgeBases: [kb])
  storage.set(activeKey, kb.id)
  let hour = Date().timeIntervalSince1970 + 3600
  try storeSession(
    storage, kbId: kb.id,
    session: HeldSignIn(
      access: jwt(.object(["exp": .number(hour)])), clientId: scriptClientID, refresh: "refresh",
      tokenEndpoint: "issuer"))
  let browser = try await newSemiontBrowser(
    SemiontBrowserConfig(
      storage: storage, sessionFactory: RecordingSessions(steps: steps) { _ in throw refusal }))
  let said: [Said]
  do {
    try await withinTestDeadline {
      for await activating in browser.sessionActivating where !activating { return }
      throw SpecFailure.shape("\(why): the activation never returned")
    }
    // What the registry said by then is what it has given `errors`: ended, they give it all.
    let errors = browser.errors()
    errors.dispose()
    said = try await withinTestDeadline {
      var said: [Said] = []
      for try await error in errors { said.append(Said(error)) }
      return said
    }
    #expect(steps.all == [askedFor(kb.id)], "\(why)")
    #expect(browser.activeSession.value == nil, "\(why): a session is active")
    #expect(storage.get(activeKey) == kb.id, "\(why): the storage's active key")
  } catch {
    try? await browser.close()
    throw error
  }
  // What its close raises is no row's to say.
  try? await browser.close()
  return said
}

@Test func aRegistrySaysItsFactorysRefusalAsTheRegistryActivationCasesSay() async throws {
  let rows = try required(activationTable(), "refused").array
  #expect(!rows.isEmpty, "session/registry-activation-cases.json holds refused cases")
  for value in rows {
    let row = try value.object
    let why = try required(row, "why").text
    let refusal = try ownError(required(row, "refusal"), kbId: "kb-a")
    let registryErrors = try required(row, "registryErrors").array.map(Said.init)
    let said = try await refusedWith(refusal, why: why)
    #expect(said == registryErrors, "\(why)")
  }
}

@Test func aRegistrySaysItsFactorysOtherFailureAsTheRegistryFactoryFailureCasesSay() async throws {
  let rows = try required(factoryFailureTable(), "cases").array
  #expect(!rows.isEmpty, "session/registry-factory-failure-cases.json holds cases")
  for value in rows {
    let row = try value.object
    let why = try required(row, "why").text
    let failure = try required(row, "failure").object
    let text = try required(failure, "transport").text
    guard let code = TransportErrorCode(rawValue: text) else {
      throw SpecFailure.shape("\(why): \(text) is no code of a transport's failures")
    }
    let registryErrors = try required(row, "registryErrors").array.map(Said.init)
    let said = try await refusedWith(
      TransportError(code, try required(failure, "message").text), why: why)
    #expect(said == registryErrors, "\(why)")
  }
}

// ── A storage that the first session's client owes a save to ────────────

/// What the storage says when it refuses a write.
private struct RefusedByTheStorage: Error, CustomStringConvertible {
  var description: String { "the storage refuses the first client's writes" }
}

/// A storage in this process that records each write of `owed`, the save the first session's
/// client owes, in `steps` as it is asked for; refuses each write of `refused`, the keys that
/// client writes under, once it is made to; and, once made to hold the owed write, runs what it is
/// given within that write and then holds it open until it is let go or the test's deadline has
/// passed. It holds on the thread that writes, so nothing else needs to run for it to go on.
private final class ActivationStorage: SessionStorage {
  private struct State: Sendable {
    var values: [String: String] = [:]
    var refusing = false
    var whileHeld: (@Sendable () -> Void)?
    var holding = false
    var letGo = false
  }
  private let owed: String
  private let refused: Set<String>
  private let steps: Steps
  private let state = Mutex(State())

  init(owed: String, refused: Set<String>, steps: Steps) {
    self.owed = owed
    self.refused = refused
    self.steps = steps
  }

  /// Every later write of the first client's keys is refused.
  func refuse() { state.withLock { $0.refusing = true } }
  /// The owed write, once asked for, runs `whileHeld`, and is then held open until ``letGo()``.
  func holdTheOwedWrite(_ whileHeld: @escaping @Sendable () -> Void) {
    state.withLock { $0.whileHeld = whileHeld }
  }
  /// Whether the owed write is held open.
  var holding: Bool { state.withLock { $0.holding } }
  /// The held write goes on.
  func letGo() { state.withLock { $0.letGo = true } }

  func get(_ key: String) -> String? { state.withLock { $0.values[key] } }
  func set(_ key: String, _ value: String) throws { try write(key) { _ in value } }
  func delete(_ key: String) { state.withLock { $0.values[key] = nil } }
  func update(_ key: String, _ change: @Sendable (String?) throws -> String?) throws {
    try write(key, change)
  }
  func subscribe(_ key: String) -> AsyncStream<String?>? { nil }

  private func write(_ key: String, _ change: (String?) throws -> String?) throws {
    if key == owed { steps.take(wroteTheOwedSave) }
    let whileHeld = state.withLock { state -> (@Sendable () -> Void)? in
      guard key == owed, let whileHeld = state.whileHeld else { return nil }
      state.whileHeld = nil
      return whileHeld
    }
    if let whileHeld {
      whileHeld()
      holdUntilLetGo()
    }
    try state.withLock { state in
      if state.refusing, refused.contains(key) { throw RefusedByTheStorage() }
      state.values[key] = try change(state.values[key])
    }
  }

  private func holdUntilLetGo() {
    state.withLock { $0.holding = true }
    let clock = ContinuousClock()
    let deadline = clock.now + .milliseconds(testDeadlineMs)
    while !state.withLock({ $0.letGo }), clock.now < deadline {
      Thread.sleep(forTimeInterval: 0.001)
    }
    state.withLock { $0.holding = false }
  }
}

/// The steps, and the storage, of a row whose first session is kb-a's and owes a save there.
private func owedOnKbA() throws -> (Steps, ActivationStorage) {
  let keys = try keysOfJoOnKbA()
  let steps = Steps()
  return (
    steps, ActivationStorage(owed: try keys.query("resource"), refused: keys.all, steps: steps)
  )
}

/// What the storage says when it is asked for a sign-in.
private struct UnreadableSignIn: Error, CustomStringConvertible {
  var description: String { "the storage cannot read a sign-in" }
}

/// A storage in this process that cannot read any knowledge base's sign-in, and keeps all else.
private final class UnreadableSignIns: SessionStorage {
  private let memory = MemorySessionStorage()

  func get(_ key: String) throws -> String? {
    guard kbOfSessionKey(key) == nil else { throw UnreadableSignIn() }
    return memory.get(key)
  }
  func set(_ key: String, _ value: String) { memory.set(key, value) }
  func delete(_ key: String) { memory.delete(key) }
  func update(_ key: String, _ change: @Sendable (String?) throws -> String?) throws {
    try memory.update(key, change)
  }
  func subscribe(_ key: String) -> AsyncStream<String?>? { nil }
}

// ── closed ──────────────────────────────────────────────────────────────

@Test func aRegistryRefusesAnActivationOnceItsCloseBeginsAsTheRegistryActivationCasesSay()
  async throws
{
  let rows = try required(activationTable(), "closed").array
  #expect(!rows.isEmpty, "session/registry-activation-cases.json holds closed cases")
  for value in rows {
    let row = try value.object
    let why = try required(row, "why").text
    let closing: Bool
    switch try required(row, "while").text {
    case "closed": closing = false
    case "closing": closing = true
    case let other: throw SpecFailure.shape("\(why): activates while \(other)")
    }
    let (steps, storage) = try owedOnKbA()
    let asked = closing ? [askedFor("kb-a"), wroteTheOwedSave] : [askedFor("kb-a")]
    try await overARegistry(
      storage: storage, kbIds: ["kb-a", "kb-b"], owingASave: closing,
      factory: { built in
        RecordingSessions(steps: steps) { options in try await built.session(options) }
      },
      run: { browser, _ in
        let errors = browser.errors()
        let said = Task { () async throws -> [String] in
          var said: [String] = []
          for try await error in errors { said.append(error.code) }
          return said
        }
        var refusals: [(any Error)?] = []
        if closing {
          let fromWithin = Mutex<Task<(any Error)?, Never>?>(nil)
          storage.holdTheOwedWrite {
            fromWithin.withLock { $0 = Task { await refusal(ofActivating: "kb-b", by: browser) } }
          }
          let whileClosing = Task { try await browser.close() }
          try await withinTestDeadline {
            while !storage.holding { try await Task.sleep(for: .milliseconds(1)) }
          }
          let fromAnother = await refusal(ofActivating: "kb-b", by: browser)
          let begunWithin = try #require(
            fromWithin.withLock { $0 }, "\(why): the owed write began no activation")
          refusals = [try await withinTestDeadline { await begunWithin.value }, fromAnother]
          #expect(storage.holding, "\(why): the owed write went on before both were refused")
          storage.letGo()
          try await withinTestDeadline { try await whileClosing.value }
        } else {
          try await browser.close()
          refusals = [await refusal(ofActivating: "kb-b", by: browser)]
        }
        for refused in refusals {
          #expect(
            (refused as? BusRequestError)?.reason == .busClosed,
            "\(why): refused with \(String(describing: refused))")
        }
        #expect(steps.all == asked, "\(why)")
        #expect(try await withinTestDeadline { try await said.value } == [], "\(why)")
        #expect(storage.get(activeKey) == "kb-a", "\(why): the storage's active key")
        // A second close does nothing.
        try await browser.close()
        #expect(steps.all == asked, "\(why): the second close")
      })
  }
}

// ── switching ───────────────────────────────────────────────────────────

@Test func aRegistryEndsItsSessionBeforeItAsksForTheNextAsTheRegistryActivationCasesSay()
  async throws
{
  let rows = try required(activationTable(), "switching").array
  #expect(!rows.isEmpty, "session/registry-activation-cases.json holds switching cases")
  for value in rows {
    let row = try value.object
    let why = try required(row, "why").text
    let refuses: Bool
    switch try required(row, "storage").text {
    case "writes": refuses = false
    case "refuses": refuses = true
    case let other: throw SpecFailure.shape("\(why): a storage that \(other)")
    }
    let next: SessionError?
    switch try required(row, "next") {
    case .string("built"): next = nil
    case let refusal: next = try ownError(refusal, kbId: "kb-b")
    }
    let registryErrors = try required(row, "registryErrors").array.map { try $0.text }
    guard case .bool(let active) = try required(row, "active") else {
      throw SpecFailure.shape("\(why): active is neither true nor false")
    }
    let (steps, storage) = try owedOnKbA()
    try await overARegistry(
      storage: storage, kbIds: ["kb-a", "kb-b"], owingASave: true,
      factory: { built in
        RecordingSessions(steps: steps) { options in
          if let next, options.kb.id == "kb-b" { throw next }
          return try await built.session(options)
        }
      },
      run: { browser, _ in
        if refuses { storage.refuse() }
        try await withinTestDeadline { try await browser.setActiveKb("kb-b") }
        // What the registry said by then is what it has given `errors`: ended, they give it all.
        let errors = browser.errors()
        errors.dispose()
        let codes = try await withinTestDeadline {
          var codes: [String] = []
          for try await error in errors { codes.append(error.code) }
          return codes
        }
        #expect(
          steps.all == [askedFor("kb-a"), wroteTheOwedSave, askedFor("kb-b")],
          "\(why): the first session's owed save written before the next was asked for")
        #expect(codes == registryErrors, "\(why)")
        #expect((browser.activeSession.value != nil) == active, "\(why): a session is active")
        #expect(storage.get(activeKey) == "kb-b", "\(why): the storage's active key")
      })
  }
}

// A close that begins while a switch waits for the session it let go of to end waits for that end
// too: the save that session's closing flush could not make is said before its errors end.
@Test func aRegistrysCloseDuringASwitchSaysTheSaveTheSessionItLetGoOfCouldNotMake() async throws {
  let (steps, storage) = try owedOnKbA()
  try await overARegistry(
    storage: storage, kbIds: ["kb-a", "kb-b"], owingASave: true,
    factory: { built in
      RecordingSessions(steps: steps) { options in try await built.session(options) }
    },
    run: { browser, _ in
      let errors = browser.errors()
      let said = Task { () async throws -> [String] in
        var said: [String] = []
        for try await error in errors { said.append(error.code) }
        return said
      }
      storage.refuse()
      storage.holdTheOwedWrite {}
      let switching = Task { try await browser.setActiveKb("kb-b") }
      try await withinTestDeadline {
        while !storage.holding { try await Task.sleep(for: .milliseconds(1)) }
      }
      let closing = Task { try await browser.close() }
      // Its close has begun once what it shows has ended.
      try await withinTestDeadline { for await _ in browser.knowledgeBases {} }
      #expect(storage.holding, "the owed write went on before the close began")
      storage.letGo()
      try await withinTestDeadline { try await closing.value }
      _ = await switching.result
      #expect(try await withinTestDeadline { try await said.value } == ["session.save-refused"])
      #expect(steps.all == [askedFor("kb-a"), wroteTheOwedSave])
    })
}

// ── closing ─────────────────────────────────────────────────────────────

// A second close, begun while the first waits for its live session's closing flush, returns at
// once.
@Test func aRegistrysSecondCloseReturnsAtOnceWhileItsFirstIsHeld() async throws {
  let (_, storage) = try owedOnKbA()
  try await overARegistry(
    storage: storage, kbIds: ["kb-a"], owingASave: true, factory: { $0 },
    run: { browser, _ in
      storage.holdTheOwedWrite {}
      let first = Task { try await browser.close() }
      try await withinTestDeadline {
        while !storage.holding { try await Task.sleep(for: .milliseconds(1)) }
      }
      try await withinTestDeadline { try await browser.close() }
      #expect(storage.holding, "the second close waited for the owed write")
      storage.letGo()
      try await withinTestDeadline { try await first.value }
    })
}

// A registry's close raises what its own work failed with, and that is said nowhere: here, the
// sign-in its storage cannot read as it activates the knowledge base. A second close raises
// nothing.
@Test func aRegistrysCloseRaisesTheSignInItCouldNotReadAndSaysItNowhere() async throws {
  let storage = UnreadableSignIns()
  try saveKnowledgeBases(
    storage,
    knowledgeBases: [
      KnowledgeBase(
        did: "did:web:kb.example.org",
        endpoint: .httpEndpoint(HttpEndpoint(host: "127.0.0.1", port: 4000, protocol: .http)),
        id: "kb-a", label: "kb-a")
    ])
  let steps = Steps()
  let browser = try await newSemiontBrowser(
    SemiontBrowserConfig(
      storage: storage,
      sessionFactory: RecordingSessions(steps: steps) { _ in
        throw SpecFailure.shape("asked for the session of a sign-in it could not read")
      }))
  let errors = browser.errors()
  let raised: (any Error)?
  do {
    try await browser.close()
    raised = nil
  } catch {
    raised = error
  }
  #expect(raised is UnreadableSignIn, "\(String(describing: raised))")
  let said = try await withinTestDeadline {
    var said: [String] = []
    for try await error in errors { said.append(error.code) }
    return said
  }
  #expect(said == [])
  #expect(steps.all == [], "the factory was asked for a session")
  try await browser.close()
}
