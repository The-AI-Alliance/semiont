import Foundation

/// Tables become typed values at build time, with no JSON parser or fallback in the SDK.
package struct TableGenerator {
  package init(specs: URL, models: ModelGenerator) {
    self.specs = specs
    self.models = models
  }
  let specs: URL
  let models: ModelGenerator

  func table(_ path: String) throws -> Schema {
    try loadJSON(specs.appendingPathComponent(path)).object
  }
  func required(_ object: Schema, _ key: String) throws -> JSONValue {
    guard let value = object[key] else {
      throw GenerationRefused(description: "table lacks \(key)")
    }
    return value
  }
  func infer(_ values: [JSONValue]) throws -> Schema {
    let nonnull = values.filter { $0 != .null }
    guard let first = nonnull.first else { return [:] }
    var result: Schema
    switch first {
    case .string:
      guard nonnull.allSatisfy({ if case .string = $0 { true } else { false } }) else {
        throw GenerationRefused(description: "mixed table field")
      }
      result = ["type": .string("string")]
    case .number:
      let numbers = try nonnull.map { v -> Double in
        guard case .number(let n) = v else {
          throw GenerationRefused(description: "mixed table field")
        }
        return n
      }
      result = ["type": .string(numbers.allSatisfy { $0.rounded() == $0 } ? "integer" : "number")]
    case .bool: result = ["type": .string("boolean")]
    case .array:
      let elements = try nonnull.flatMap { try $0.array }
      result = ["type": .string("array"), "items": .object(try infer(elements))]
    case .object:
      let objects = try nonnull.map { try $0.object }
      let keys = Set(objects.flatMap(\.keys))
      var properties: Schema = [:]
      var required: [JSONValue] = []
      for key in keys.sorted() {
        let entries = objects.compactMap { $0[key] }
        properties[key] = .object(try infer(entries))
        if entries.count == objects.count { required.append(.string(key)) }
      }
      result = [
        "type": .string("object"), "properties": .object(properties), "required": .array(required),
      ]
    case .null: throw GenerationRefused(description: "unreachable null inference")
    }
    if nonnull.count != values.count { result["nullable"] = .bool(true) }
    return result
  }
  func expression(_ value: JSONValue, type: Schema, owner: String, part: String) throws -> String {
    let resolved = try models.nonnull(type).0
    if resolved.isEmpty { return jsonExpression(value) }
    switch value {
    case .null: return "nil"
    case .bool(let b): return String(b)
    case .string(let text): return literal(text)
    case .number(let n): return n.rounded() == n ? String(Int(n)) : String(n)
    case .array(let list):
      let item = try required(resolved, "items").object
      return "["
        + (try list.map { try expression($0, type: item, owner: owner, part: part + "Item") })
        .joined(separator: ", ") + "]"
    case .object(let object):
      let name = try models.type(owner, part, resolved)
      let properties = try required(resolved, "properties").object
      let requiredKeys = Set(try required(resolved, "required").array.map { try $0.text })
      let args = try properties.sorted(by: { $0.key < $1.key }).compactMap {
        key, schema -> String? in
        guard let entry = object[key] else { return nil }
        let field = try schema.object
        var value = try expression(entry, type: field, owner: name, part: key)
        if !requiredKeys.contains(key), try models.nonnull(field).1 {
          value = entry == .null ? ".null" : ".value(\(value))"
        }
        return "\(memberName(key)): \(value)"
      }
      return "\(name)(\(args.joined(separator: ", ")))"
    }
  }
  func jsonExpression(_ value: JSONValue) -> String {
    switch value {
    case .null: ".null"
    case .bool(let b): ".bool(\(b))"
    case .number(let n): ".number(\(n))"
    case .string(let s): ".string(\(literal(s)))"
    case .array(let list): ".array([\(list.map(jsonExpression).joined(separator: ", "))])"
    case .object(let object):
      ".object([\(object.sorted(by: { $0.key < $1.key }).map { literal($0.key) + ": " + jsonExpression($0.value) }.joined(separator: ", "))])"
    }
  }
  package func generate() throws -> String {
    var out = "// Generated from protocol/specs/src tables; do not edit.\nimport Foundation\n"
    _ = try models.inline(
      "", "HeldSignIn", required(table("session/stored.json"), "storedSession").object)
    var received = try models.schema("BusFrame")
    var fields = try required(received, "properties").object
    let projection = fields.keys.sorted().map {
      "\(memberName($0)): frame.\(escaped(memberName($0)))"
    }.joined(separator: ", ")
    out +=
      "extension ReceivedFrame { internal init(_ frame: BusFrame, trace: [String: String]?) { self.init(\(projection), trace: trace) } }\n"
    fields["trace"] = .object([
      "type": .string("object"), "additionalProperties": .object(["type": .string("string")]),
    ])
    received["properties"] = .object(fields)
    _ = try models.inline("", "ReceivedFrame", received)
    let timing = try required(table("client/timing.json"), "timing").array
    out +=
      "internal struct RetryBudget: Sendable { let attempts: Int; let initialDelayMs: Int; let maxDelayMs: Int }\ninternal enum Timings {\n"
    for raw in timing {
      let row = try raw.object
      let name = try required(row, "name").text
      let value = try required(row, "value")
      if case .number(let number) = value, number.rounded() == number {
        out += "  static let \(escaped(name)): Int = \(Int(number))\n"
      } else {
        let parts = try value.object
        guard Set(parts.keys) == Set(["attempts", "initialDelayMs", "maxDelayMs"]) else {
          throw GenerationRefused(description: "unknown retry budget \(name)")
        }
        let arguments = try ["attempts", "initialDelayMs", "maxDelayMs"].map { key -> String in
          guard case .number(let n) = try required(parts, key), n.rounded() == n else {
            throw GenerationRefused(description: "non-integer retry budget")
          }
          return "\(key): \(Int(n))"
        }
        out += "  static let \(escaped(name)) = RetryBudget(\(arguments.joined(separator: ", ")))\n"
      }
    }
    out += "}\n"
    for (key, name) in [("spans", "TransportSpan"), ("metrics", "TransportMetric")] {
      let rows = try required(table("sdk-telemetry/telemetry.json"), key).array
      out +=
        try models.enumeration(
          name, rows.map { try required($0.object, "name") }, ["type": .string("string")]) + "\n"
    }
    let errors = try table("errors/codes.json")
    for (family, raw) in errors.sorted(by: { $0.key < $1.key }) where !family.hasPrefix("$") {
      let codes = try required(raw.object, "codes").array.map { try required($0.object, "code") }
      let name = pascal(family) + "ErrorCode"
      out += try models.enumeration(name, codes, ["type": .string("string")]) + "\n"
    }
    out += try errorClassifiers(errors)
    // Names identify table roles, not handwritten copies of their rows or vocabularies.
    for (path, key, name) in [
      ("sdk-telemetry/telemetry.json", "spans", "telemetrySpans"),
      ("sdk-telemetry/telemetry.json", "metrics", "telemetryMetrics"),
      ("session/oauth.json", "clients", "oauthClients"),
      ("session/oauth.json", "scope", "signInScope"),
      ("sign-in-store/owner-only.json", "directoryMode", "ownerOnlyDirectory"),
      ("sign-in-store/owner-only.json", "fileMode", "ownerOnlyFile"),
      ("media-types/registry.json", "mediaTypes", "mediaTypes"),
      ("text/encoding-cases.json", "cases", "encodings"),
      ("client/refresh.json", "queries", "cacheQueries"),
      ("client/refresh.json", "refresh", "cacheRefresh"),
      ("bus/registry.json", "audience", "busAudience"),
      ("bus/log-cases.json", "names", "credentialNames"),
    ] {
      let value = try required(table(path), key)
      let shape = try infer([value])
      let type = try models.type("Spec", name, shape)
      let expression = try expression(value, type: shape, owner: "Spec", part: name)
      out += "internal let \(escaped(name)): \(type) = \(expression)\n"
    }
    let aliases = try required(table("media-types/registry.json"), "extensionAliases").object
    out += "internal let extensionAliases: [String: String] = [\n"
    for (suffix, type) in aliases.sorted(by: { $0.key < $1.key }) {
      out += "  \(literal(suffix)): \(literal(try type.text)),\n"
    }
    out += "]\n"
    let registry = try table("bus/registry.json")
    out +=
      "internal let traceField = \(literal(try required(required(registry, "trace").object, "field").text))\n"
    out += try channels(registry)
    return out
  }
  func errorClassifiers(_ errors: Schema) throws -> String {
    let transport = try required(errors, "transport").object
    let codes = try required(transport, "codes").array.map { try $0.object }
    var out = "internal func transportErrorCode(for status: Int) -> TransportErrorCode {\n"
    for key in ["status", "statusFrom"] {
      for row in codes {
        guard let value = row[key], case .number(let status) = value, status.rounded() == status
        else { continue }
        let code = try required(row, "code").text
        out +=
          "  if status \(key == "status" ? "==" : ">=") \(Int(status)) { return .\(escaped(enumCase(code))) }\n"
      }
    }
    out += "  return .\(escaped(enumCase(try required(transport, "unclassified").text)))\n}\n"
    let bus = try required(errors, "busRequest").object
    out += "internal let busRequestCodeByWireCode: [String: BusRequestErrorCode] = [\n"
    for raw in try required(bus, "codes").array {
      let row = try raw.object
      if let wire = row["wire"] {
        out +=
          "  \(literal(try wire.text)): .\(escaped(enumCase(try required(row, "code").text))),\n"
      }
    }
    out +=
      "]\ninternal let unrecognizedBusFailure: BusRequestErrorCode = .\(escaped(enumCase(try required(bus, "unrecognizedFailure").text)))\n"
    return out
  }
  func stamps(_ raw: Schema, seen: Set<String> = []) throws -> Set<String> {
    if let ref = raw["$ref"] {
      let name = try ref.text
      guard !seen.contains(name) else { return [] }
      return try stamps(models.schema(name), seen: seen.union([name]))
    }
    if let members = raw["oneOf"] ?? raw["anyOf"] {
      let sets = try members.array.map { try stamps($0.object, seen: seen) }
      guard let first = sets.first, sets.allSatisfy({ $0 == first }) else {
        throw GenerationRefused(description: "union members have different stamps")
      }
      return first
    }
    var found = Set(try raw["properties"]?.object.keys.filter { $0.hasPrefix("_") } ?? [])
    if let all = raw["allOf"] {
      for member in try all.array { found.formUnion(try stamps(member.object, seen: seen)) }
    }
    return found
  }
  func channels(_ registry: Schema) throws -> String {
    let audience = try required(registry, "audience").object
    let scoped = Set(try required(audience, "scoped").array.map { try $0.text })
    let everyone = Set(try required(audience, "everyone").array.map { try $0.text })
    var rows: [String: (type: String, schema: Schema?)] = [:]
    var out = """
      internal struct Channel<Payload: Codable & Sendable>: Sendable {
        let name: String
        let stamps: Set<String>
      }
      internal struct ScopedChannel<Payload: Codable & Sendable>: Sendable {
        let name: String
        let stamps: Set<String>
      }
      internal struct ResponseEnvelope<Payload: Codable & Sendable>: Codable, Sendable {
        let response: Payload
      }
      internal struct Operation<Request: Codable & Sendable, Result: Codable & Sendable, Failure: Codable & Sendable>: Sendable {
        let request: Channel<Request>
        let result: Channel<Result>
        let failure: Channel<Failure>
        let replyNames: [String]
      }
      internal enum Channels {
      """ + "\n"
    _ = try models.inline(
      "Bus", "EmptyPayload", ["type": .string("object"), "additionalProperties": .bool(false)])
    for raw in try required(registry, "channels").array {
      let row = try raw.object
      let name = try required(row, "channel").text
      guard rows[name] == nil else {
        throw GenerationRefused(description: "duplicate channel \(name)")
      }
      let shape = try required(row, "shape").text
      let payload: String
      let schema: Schema?
      let stamps: Set<String>
      switch shape {
      case "schema":
        payload = try required(row, "schema").text
        schema = try models.schema(payload)
        stamps = try self.stamps(models.schema(payload))
      case "envelope":
        let inner = try required(row, "schema").text
        _ = try models.named(inner)
        payload = "ResponseEnvelope<\(inner)>"
        schema = nil
        stamps = []
      case "storedEvent":
        _ = try models.schema(required(row, "payload").text)
        payload = row["enriched"] == .bool(true) ? "EnrichedResourceEvent" : "StoredEventResponse"
        schema = nil
        stamps = try self.stamps(models.schema(payload))
      case "empty", "void":
        payload = "BusEmptyPayload"
        schema = nil
        stamps = []
      default: throw GenerationRefused(description: "unknown channel shape \(shape)")
      }
      rows[name] = (payload, schema)
      let channelType = scoped.contains(name) ? "ScopedChannel" : "Channel"
      out +=
        "  static let \(escaped(memberName(name))): \(channelType)<\(payload)> = .init(name: \(literal(name)), stamps: Set([\(stamps.sorted().map(literal).joined(separator: ", "))]))\n"
    }
    guard scoped.union(everyone).isSubset(of: Set(rows.keys)) else {
      throw GenerationRefused(description: "audience names an unknown channel")
    }
    out += "}\ninternal enum Operations {\n"
    var replies: Set<String> = []
    for raw in try required(registry, "operations").array {
      let row = try raw.object
      let names = try ["request", "result", "failure"].map { try required(row, $0).text }
      let channels = try names.map { name in
        guard let channel = rows[name], !scoped.contains(name) else {
          throw GenerationRefused(description: "operation channel \(name) is missing or scoped")
        }
        return channel
      }
      replies.formUnion(names.dropFirst())
      let answer = try channels[1].schema.map { try models.merged($0) }
      if answer?["oneOf"] != nil || answer?["anyOf"] != nil {
        throw GenerationRefused(description: "union reply needs explicit reply-name handling")
      }
      let replyNames =
        try answer?["required"]?.array.map { try $0.text }.filter { $0 != "response" } ?? []
      if !replyNames.isEmpty {
        guard let request = channels[0].schema else {
          throw GenerationRefused(description: "reply names without request schema")
        }
        let properties = try models.merged(request)["properties"]?.object ?? [:]
        guard replyNames.allSatisfy({ properties[$0] != nil }) else {
          throw GenerationRefused(description: "reply names missing from request")
        }
      }
      out +=
        "  static let \(escaped(memberName(names[0]))): Operation<\(channels.map(\.type).joined(separator: ", "))> = .init(request: Channels.\(escaped(memberName(names[0]))), result: Channels.\(escaped(memberName(names[1]))), failure: Channels.\(escaped(memberName(names[2]))), replyNames: [\(replyNames.map(literal).joined(separator: ", "))])\n"
    }
    out += "}\ninternal let wireOperations: [String: WireOperation] = [\n"
    for raw in try required(registry, "operations").array {
      let row = try raw.object
      let names = try ["request", "result", "failure"].map { try required(row, $0).text }
      guard let request = rows[names[0]], let response = rows[names[1]] else {
        throw GenerationRefused(description: "missing operation channels")
      }
      out +=
        "  \(literal(names[0])): WireOperation(result: \(literal(names[1])), failure: \(literal(names[2])), request: { try projectWire(\(request.type).self, $0) }, response: { try projectWire(\(response.type).self, $0) }),\n"
    }
    guard scoped.isDisjoint(with: everyone.union(replies)) else {
      throw GenerationRefused(description: "channel delivered both scoped and everywhere")
    }
    out +=
      "]\ninternal let bridgedChannels = [\(everyone.union(replies).sorted().map(literal).joined(separator: ", "))]\n"
    let refresh = try table("client/refresh.json")
    let queries = try required(refresh, "queries").array.map { try $0.object }
    let queryNames = try queries.map { try required($0, "name").text }
    guard Set(queryNames).count == queryNames.count else {
      throw GenerationRefused(description: "duplicate cache query")
    }
    for raw in try required(refresh, "refresh").array {
      let row = try raw.object
      let trigger = try required(row, "on").text
      guard trigger == "reopened" || rows[trigger] != nil else {
        throw GenerationRefused(description: "unknown cache refresh trigger \(trigger)")
      }
      for key in ["refetches", "writes", "removes"] {
        if let value = row[key] {
          for name in try value.array.map({ try $0.text }) where !queryNames.contains(name) {
            throw GenerationRefused(description: "unknown cache query \(name)")
          }
        }
      }
      if let reach = row["reach"], !["subject", "held"].contains(try reach.text) {
        throw GenerationRefused(description: "unknown refresh reach")
      }
      if let when = row["when"], !["enriched", "unenriched"].contains(try when.text) {
        throw GenerationRefused(description: "unknown refresh condition")
      }
    }
    out +=
      try models.enumeration(
        "CacheQuery", queryNames.map(JSONValue.string), ["type": .string("string")]
      ).replacingOccurrences(of: "public ", with: "internal ") + "\n"
    out += "internal protocol CacheQueryHandlers {\n"
    for query in queries {
      let name = try required(query, "name").text
      out += "  func \(escaped(memberName(name)))()\n"
    }
    out += "}\n"
    return out
  }
}
