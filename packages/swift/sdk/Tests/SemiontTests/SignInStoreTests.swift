import Foundation
import Synchronization
import Testing

@testable import Semiont

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

@Test func stateHomeRunsEverySharedCase() throws {
  for value in try required(Spec.read("sign-in-store/cases.json").object, "cases").array {
    let row = try value.object
    func text(_ key: String) -> String? {
      if case .string(let value) = row[key] { value } else { nil }
    }
    let platform: Platform =
      text("os") == "macos" ? .macos : text("os") == "windows" ? .windows : .other
    let actual =
      stateDir(
        platform: platform, home: text("home"), xdgStateHome: text("xdgStateHome"),
        localAppData: text("localAppData")
      ).map(JSONValue.string) ?? .null
    #expect(actual == (try required(row, "dir")))
  }
}
@Test func everyStoreRunsEveryRenewalRace() async throws {
  let rows = try required(Spec.read("sign-in-store/cases.json").object, "renewals").array
  for disk in [false, true] {
    for value in rows {
      let row = try value.object
      let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
      defer { try? FileManager.default.removeItem(at: root) }
      let store: any SignInKept =
        disk
        ? SignInStore(path: root.appendingPathComponent("tokens.json")).entry("local:test")
        : MemorySignIn()
      let expired = try Set(required(row, "expired").array.map { try $0.text })
      let now = Date().timeIntervalSince1970
      func access(_ name: String) throws -> String {
        try jwt(
          .object([
            "iss": .string("https://issuer"), "email": .string("alice@test"), "name": .string(name),
            "exp": .number(now + (expired.contains(name) ? -3600 : 3600)),
          ]))
      }
      func held(_ value: JSONValue) throws -> HeldSignIn {
        let entry = try value.object
        return try HeldSignIn(
          access: access(required(entry, "token").text), clientId: scriptClientID,
          refresh: required(entry, "refreshToken").text, tokenEndpoint: "http://issuer/token")
      }
      let initial = try held(required(row, "kept"))
      try await store.keep(initial)
      let meantime = row["meanwhile"]
      let before: Bool
      if case .object(let event) = meantime {
        before = event["when"] == .string("before")
      } else {
        before = false
      }
      let replacement: HeldSignIn?
      if case .object(let event) = meantime, let theirs = event["theirs"] {
        replacement = try held(theirs)
      } else {
        replacement = nil
      }
      func alter() async throws {
        if let replacement { try await store.keep(replacement) } else { try await store.forget() }
      }
      if before { try await alter() }
      let issued = try required(row, "issues").object
      let nextAccess = try access(required(issued, "token").text)
      let nextRefresh = try issued["refreshToken"].map { try $0.text }
      let spent = Mutex<[String]>([])
      let holding: String? =
        if case .string(let name) = row["holding"] { try access(name) } else { nil }
      let during = meantime != .null && !before
      let given = try await renewKept(store, holding: holding) { read in
        spent.withLock { $0.append(read.refresh) }
        if during {
          if let replacement { try await store.keep(replacement) } else { try await store.forget() }
        }
        return IssuedTokens(access: nextAccess, refresh: nextRefresh ?? read.refresh)
      }
      let spends: [String] =
        if case .string(let expected) = row["spends"] { [expected] } else { [] }
      #expect(spent.withLock { $0 } == spends)
      let expectedGiven: String? =
        if case .string(let expected) = row["gives"] { try access(expected) } else { nil }
      #expect(given == expectedGiven)
      let left = try await store.held()
      if row["leaves"] == .null {
        #expect(left == nil)
      } else {
        let expected = try held(required(row, "leaves"))
        #expect(left?.access == expected.access)
        #expect(left?.refresh == expected.refresh)
      }
    }
  }
}
@Test func diskStoreKeepsUnknownMembersAndOwnerOnlyModes() async throws {
  let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
  defer { try? FileManager.default.removeItem(at: root) }
  let store = SignInStore(path: root.appendingPathComponent("tokens.json"))
  try store.change { document in
    document["future"] = .array([.null, .bool(true)])
    return ((), true)
  }
  let entry = store.entry("local:test")
  let token = try jwt(.object(["iss": .string("https://issuer"), "exp": .number(1_900_000_000)]))
  try await entry.keep(
    HeldSignIn(
      access: token, clientId: scriptClientID, refresh: "refresh",
      tokenEndpoint: "http://issuer/token"))
  #expect(try store.read()["future"] == .array([.null, .bool(true)]))
  for (path, mode) in [
    (root, 0o700), (root.appendingPathComponent("tokens.json"), 0o600),
    (root.appendingPathComponent("tokens.lock"), 0o600),
  ] {
    let attributes = try FileManager.default.attributesOfItem(atPath: path.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == mode)
  }
  try await entry.forget()
  #expect(try store.read()["future"] == .array([.null, .bool(true)]))
}
#if os(Linux)
  @Test func diskStoreWaitsForAnotherProcessesFlock() async throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let process = Process()
    let input = Pipe()
    let output = Pipe()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/flock")
    process.arguments = [
      "-x", root.appendingPathComponent("tokens.lock").path, "/bin/sh", "-c",
      "printf locked; read release",
    ]
    process.standardInput = input
    process.standardOutput = output
    try process.run()
    defer {
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
    }
    let locked = output.fileHandleForReading.readData(ofLength: 6)
    #expect(String(decoding: locked, as: UTF8.self) == "locked")
    let completed = Mutex(false)
    let store = SignInStore(path: root.appendingPathComponent("tokens.json"))
    let writing = Task.detached {
      try store.change { document in
        document["test"] = .bool(true)
        return ((), true)
      }
      completed.withLock { $0 = true }
    }
    try await sleepMilliseconds(30)
    #expect(!completed.withLock { $0 })
    try input.fileHandleForWriting.write(contentsOf: Data("release\n".utf8))
    try await within(testDeadlineMs) { try await writing.value }
    #expect(completed.withLock { $0 })
  }
#endif
