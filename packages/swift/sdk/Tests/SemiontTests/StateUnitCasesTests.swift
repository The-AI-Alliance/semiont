import Testing

@testable import Semiont

@Test func sessionSignalsRunEverySharedCase() async throws {
  let table = try Spec.read("client/state-units.json").object
  let rows = try required(table, "cases").array.map { try $0.object }
  let cases = try rows.filter { try required($0, "unit").text == "sessionSignals" }
  try #require(!cases.isEmpty)
  for row in cases {
    let name = try required(row, "case").text
    let signals = SessionSignals()
    for value in try required(row, "steps").array {
      let step = try value.object
      if let invoke = step["invoke"] {
        let args = try required(step, "args").object
        switch try invoke.text {
        case "notifySessionEnded":
          signals.notifySessionEnded(try decoded(SessionEndReason.self, required(args, "reason")))
        case "notifyPermissionDenied":
          signals.notifyPermissionDenied(try decoded(String?.self, required(args, "detail")))
        case "notifyKbIdentityConflict":
          signals.notifyKbIdentityConflict(
            try decoded(KbIdentityConflict.self, required(args, "conflict")))
        case "acknowledgeSessionEnded": signals.acknowledgeSessionEnded()
        case "acknowledgePermissionDenied": signals.acknowledgePermissionDenied()
        case "acknowledgeKbIdentityConflict": signals.acknowledgeKbIdentityConflict()
        default: Issue.record("Unknown signal method in \(name)")
        }
      } else if let expect = step["expect"] {
        let values = try required(expect.object, "unit").object
        let actual = [
          "sessionEnded": try encoded(signals.sessionEnded.value),
          "permissionDenied": try encoded(signals.permissionDenied.value),
          "kbIdentityConflict": try encoded(signals.kbIdentityConflict.value),
        ]
        for (member, expected) in values {
          #expect(actual[member] == expected, "\(name) — \(member)")
        }
      } else if step["dispose"] == .string("unit") {
        signals.dispose()
      } else if let ended = step["ended"] {
        for member in try required(ended.object, "unit").array {
          switch try member.text {
          case "sessionEnded": await expectEnded(signals.sessionEnded)
          case "permissionDenied": await expectEnded(signals.permissionDenied)
          case "kbIdentityConflict": await expectEnded(signals.kbIdentityConflict)
          default: Issue.record("Unknown signal in \(name)")
          }
        }
      } else {
        Issue.record("Unknown step in \(name)")
      }
    }
  }
}

private func expectEnded<Value: Sendable>(_ signal: Watched<Value>) async {
  var reader = signal.makeAsyncIterator()
  _ = await reader.next()
  if case .some = await reader.next() { Issue.record("Signal did not end") }
}

@Test func sessionSignalsDeliverRepeatedNotices() async throws {
  let signals = SessionSignals()
  var reader = signals.sessionEnded.makeAsyncIterator()
  _ = await reader.next()
  signals.notifySessionEnded(.expired)
  signals.notifySessionEnded(.expired)
  signals.dispose()
  #expect(await reader.next()??.reason == .expired)
  #expect(await reader.next()??.reason == .expired)
  if case .some = await reader.next() { Issue.record("Signal did not end") }
}
