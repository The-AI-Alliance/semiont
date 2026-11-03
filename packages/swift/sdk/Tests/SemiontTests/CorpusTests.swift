import Foundation
import Testing

@testable import Semiont

private func resolved(_ value: JSONValue, names: [String: JSONValue]) throws -> JSONValue? {
  switch value {
  case .object(let object):
    if let key = object["$var"] { return names[try key.text] }
    if let joined = object["$join"] {
      var text = ""
      for item in try joined.array {
        guard let value = try resolved(item, names: names) else { return nil }
        switch value {
        case .string(let part): text += part
        case .number(let number):
          text += number.rounded() == number ? String(Int(number)) : String(number)
        default: throw SpecFailure.shape("join contains a non-scalar")
        }
      }
      return .string(text)
    }
    var result: [String: JSONValue] = [:]
    for (key, member) in object {
      guard let value = try resolved(member, names: names) else { return nil }
      result[key] = value
    }
    return .object(result)
  case .array(let list):
    var result: [JSONValue] = []
    for item in list {
      guard let value = try resolved(item, names: names) else { return nil }
      result.append(value)
    }
    return .array(result)
  case .string("_"): return nil
  default: return value
  }
}
private func frames(
  _ value: JSONValue, names: inout [String: JSONValue], found: inout [(String, JSONValue)]
) throws {
  switch value {
  case .object(let object):
    if let bindings = object["let"] {
      for (key, value) in try bindings.object {
        if let resolved = try resolved(value, names: names) { names[key] = resolved }
      }
    }
    if let channel = object["channel"], let raw = object["payload"],
      let payload = try resolved(raw, names: names)
    {
      found.append((try channel.text, payload))
    }
    // Steps are arrays. An object's members do not impose another execution order.
    for key in object.keys.sorted() {
      if let value = object[key] { try frames(value, names: &names, found: &found) }
    }
  case .array(let list): for item in list { try frames(item, names: &names, found: &found) }
  default: break
  }
}
private func withoutDroppedStamps(_ input: JSONValue, _ back: JSONValue) throws -> JSONValue {
  switch (input, back) {
  case (.object(let before), .object(let after)):
    var result: [String: JSONValue] = [:]
    for (key, value) in before {
      if let written = after[key] {
        result[key] = try withoutDroppedStamps(value, written)
      } else if !key.hasPrefix("_") {
        throw SpecFailure.shape("model lost \(key)")
      }
    }
    return .object(result)
  case (.array(let before), .array(let after)) where before.count == after.count:
    return .array(try zip(before, after).map { try withoutDroppedStamps($0, $1) })
  default: return input
  }
}

@Test func corpusPayloadsRoundTripThroughGeneratedModels() throws {
  let channels = try required(Spec.read("bus/registry.json").object, "channels").array
  var payloads: [String: (String, Bool)] = [:]
  for raw in channels {
    let row = try raw.object
    let name = try required(row, "channel").text
    let shape = try required(row, "shape").text
    switch shape {
    case "schema", "envelope":
      payloads[name] = (try required(row, "schema").text, shape == "envelope")
    case "storedEvent": payloads[name] = (try required(row, "payload").text, false)
    case "empty", "void": break
    default: throw SpecFailure.shape("unknown channel shape \(shape)")
    }
  }
  // These corpus payloads intentionally violate their schemas; both must remain refused.
  let refusals: [(String, JSONValue)] = [
    (
      "failure-codes.json",
      .object(["message": .string("a code from the future"), "code": .string("not-invented-yet")])
    ),
    (
      "malformed-reply.json",
      .object([
        "response": .object([
          "status": .string("running"), "params": .object(["resourceId": .string("r1")]),
        ])
      ])
    ),
  ]
  var refused: Set<String> = []
  var held = 0
  for directory in [
    "protocol/conformance/sdk/wire", "protocol/conformance/sdk/live", "protocol/conformance/worker",
  ] {
    for file in try Spec.jsonFiles(directory) {
      let value = try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
      var names = Dictionary(
        uniqueKeysWithValues: ["r1", "r2", "r3", "a1", "a2"].map { ($0, JSONValue.string($0)) })
      for name in ["client", "participant"] {
        names[name] = .string("did:web:example.org:users:" + name)
      }
      var found: [(String, JSONValue)] = []
      try frames(value, names: &names, found: &found)
      for (channel, payload) in found {
        guard let (schema, enveloped) = payloads[channel] else { continue }
        let input: JSONValue
        if enveloped {
          guard let response = try payload.object["response"] else { continue }
          input = response
        } else {
          input = payload
        }
        if refusals.contains(where: { $0.0 == file.lastPathComponent && $0.1 == payload }) {
          #expect(throws: (any Error).self) { try roundTripModel(schema, input) }
          refused.insert(file.lastPathComponent)
          continue
        }
        held += 1
        do {
          let back = try roundTripModel(schema, input)
          #expect(
            try withoutDroppedStamps(input, back) == back, "\(file.lastPathComponent) \(channel)")
        } catch { Issue.record("\(file.lastPathComponent) \(channel) as \(schema): \(error)") }
      }
    }
  }
  #expect(refused == Set(refusals.map(\.0)))
  #expect(held >= 150, "corpus walk checked only \(held) payloads")
}
