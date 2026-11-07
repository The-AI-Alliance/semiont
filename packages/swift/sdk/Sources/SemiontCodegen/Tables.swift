import Foundation

/// Tables become typed values at build time, with no JSON parser or fallback in the SDK.
package struct TableGenerator {
  package init(specs: URL, required: URL, models: ModelGenerator) {
    self.specs = specs
    self.requiredTable = required
    self.models = models
  }
  let specs: URL
  /// The SDK's copy of the table of what each component schema requires, which
  /// packages/codegen/schemas/generate-required.mjs writes.
  let requiredTable: URL
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
    var gatherOptions = try models.schema("GatherResourceRequestOptions")
    gatherOptions.removeValue(forKey: "required")
    _ = try models.inline("", "GatherResourceOptions", gatherOptions)
    var received = try models.schema("BusFrame")
    var fields = try required(received, "properties").object
    let receiveMetadata: [String: JSONValue] = [
      "eventId": .object(["type": .string("string")]),
      "trace": .object([
        "type": .string("object"), "additionalProperties": .object(["type": .string("string")]),
      ]),
    ]
    fields.merge(receiveMetadata) { _, metadata in metadata }
    let projection = fields.keys.sorted().map { name in
      let member = memberName(name)
      let source = receiveMetadata[name] == nil ? "frame.\(escaped(member))" : member
      return "\(member): \(source)"
    }.joined(separator: ", ")
    out +=
      "extension ReceivedFrame { internal init(_ frame: BusFrame, trace: [String: String]?, eventId: String?) { self.init(\(projection)) } }\n"
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
    out += try keptTable()
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
  /// What each component schema requires of a value, by its name, as the shared generator wrote it.
  func requiredShapes() throws -> Schema {
    let shapes = try required(loadJSON(requiredTable).object, "schemas").object
    guard !shapes.isEmpty else {
      throw GenerationRefused(description: "the table of what each schema requires holds none")
    }
    return shapes
  }
  /// A shape of the table as the value the walk reads (Sources/Semiont/Bus/Required.swift). Each
  /// part's meaning is packages/codegen/schemas/required-shapes.mjs's; a part this does not know
  /// refuses generation, so the walk cannot fall behind the table unseen.
  func shapeLiteral(_ raw: JSONValue) throws -> String {
    let shape = try raw.object
    let parts = [
      "ref", "kinds", "enum", "pattern", "minLength", "maxLength", "minimum", "maximum",
      "minItems", "maxItems", "required", "members", "closed", "items", "values", "oneOf",
      "discriminator", "allOf",
    ]
    for key in shape.keys where !parts.contains(key) {
      throw GenerationRefused(description: "a shape states \(key), which the walk does not read")
    }
    var stated: [String] = []
    for key in parts {
      guard let value = shape[key] else { continue }
      let label = key == "enum" ? "enumeration" : key
      stated.append("\(label): \(try partLiteral(key, value))")
    }
    return "Shape(\(stated.joined(separator: ", ")))"
  }
  func partLiteral(_ key: String, _ value: JSONValue) throws -> String {
    switch key {
    case "ref": return literal(try value.text)
    case "kinds": return "[\(try value.array.map(kindLiteral).joined(separator: ", "))]"
    case "enum": return "[\(try value.array.map(listedLiteral).joined(separator: ", "))]"
    case "pattern": return "[\(try value.array.map(stepLiteral).joined(separator: ", "))]"
    case "minLength", "maxLength", "minItems", "maxItems": return try countLiteral(value)
    case "minimum", "maximum":
      guard case .number(let number) = value else {
        throw GenerationRefused(description: "\(key) is \(value), which is no number")
      }
      return "\(number)"
    case "required", "closed":
      return "[\(try value.array.map { literal(try $0.text) }.joined(separator: ", "))]"
    case "members":
      let members = try value.object.sorted(by: { $0.key < $1.key }).map {
        "\(literal($0.key)): \(try shapeLiteral($0.value))"
      }
      return members.isEmpty ? "[:]" : "[\(members.joined(separator: ", "))]"
    case "items", "values": return try shapeLiteral(value)
    case "oneOf", "allOf": return "[\(try value.array.map(shapeLiteral).joined(separator: ", "))]"
    case "discriminator": return try discriminatorLiteral(value.object)
    default: throw GenerationRefused(description: "a shape states \(key)")
    }
  }
  func kindLiteral(_ value: JSONValue) throws -> String {
    let kind = try value.text
    guard ["object", "array", "string", "integer", "number", "boolean", "null"].contains(kind)
    else {
      throw GenerationRefused(description: "\(kind) is no kind of value")
    }
    return "." + kind
  }
  func listedLiteral(_ value: JSONValue) throws -> String {
    switch value {
    case .null: return ".null"
    case .bool(let truth): return ".bool(\(truth))"
    case .number(let number): return ".number(\(number))"
    case .string(let text): return ".string(\(literal(text)))"
    case .array, .object: throw GenerationRefused(description: "an enum states \(value)")
    }
  }
  func countLiteral(_ value: JSONValue) throws -> String {
    guard case .number(let number) = value, number.rounded() == number, number >= 0 else {
      throw GenerationRefused(description: "\(value) is no count")
    }
    return "\(Int(number))"
  }
  func stepLiteral(_ value: JSONValue) throws -> String {
    let step = try value.object
    let ranges = try required(step, "of").array.map { range -> String in
      let ends = try range.array.map(countLiteral)
      guard ends.count == 2 else {
        throw GenerationRefused(description: "\(range) is no range of code points")
      }
      return "\(ends[0])...\(ends[1])"
    }
    let least = try countLiteral(required(step, "min"))
    guard let most = step["max"] else {
      return "Step(of: [\(ranges.joined(separator: ", "))], min: \(least), max: nil)"
    }
    return
      "Step(of: [\(ranges.joined(separator: ", "))], min: \(least), max: \(try countLiteral(most)))"
  }
  /// A table of shapes by name, built one entry to a statement: the type checker takes one
  /// dictionary literal of every shape as a single expression, which outgrows its time and memory.
  func shapeTable(_ name: String, _ shapes: [String: String]) -> String {
    var out = "internal let \(name): [String: Shape] = {\n  var shapes: [String: Shape] = [:]\n"
    for (key, shape) in shapes.sorted(by: { $0.key < $1.key }) {
      out += "  shapes[\(literal(key))] = \(shape)\n"
    }
    return out + "  return shapes\n}()\n"
  }
  func discriminatorLiteral(_ discriminator: Schema) throws -> String {
    let property = literal(try required(discriminator, "property").text)
    let mapping = try required(discriminator, "mapping").object.sorted(by: { $0.key < $1.key }).map
    {
      "\(literal($0.key)): \(try countLiteral($0.value))"
    }
    return
      "Discriminator(property: \(property), mapping: [\(mapping.isEmpty ? ":" : mapping.joined(separator: ", "))])"
  }
  func channels(_ registry: Schema) throws -> String {
    let audience = try required(registry, "audience").object
    let scoped = Set(try required(audience, "scoped").array.map { try $0.text })
    let everyone = Set(try required(audience, "everyone").array.map { try $0.text })
    var rows: [String: (type: String, schema: Schema?)] = [:]
    let schemaShapes = try requiredShapes()
    func componentShape(_ name: String) throws -> String {
      guard schemaShapes[name] != nil else {
        throw GenerationRefused(description: "\(name) is in no table of what a schema requires")
      }
      return "Shape(ref: \(literal(name)))"
    }
    var payloadShapes: [String: String] = [:]
    var out = """
      public struct Channel<Payload: Codable & Sendable>: Sendable {
        public let name: String
        let stamps: Set<String>
      }
      public struct ScopedChannel<Payload: Codable & Sendable>: Sendable {
        public let name: String
        let stamps: Set<String>
      }
      public struct ResponseEnvelope<Payload: Codable & Sendable>: Codable, Sendable {
        public let response: Payload
      }
      public struct Operation<Request: Codable & Sendable, Result: Codable & Sendable, Failure: Codable & Sendable>: Sendable {
        let request: Channel<Request>
        let result: Channel<Result>
        let failure: Channel<Failure>
        let replyNames: [String]
      }
      public enum Channels {
      """ + "\n"
    _ = try models.inline(
      "Bus", "EmptyPayload", ["type": .string("object"), "additionalProperties": .bool(false)])
    var storedEventChannels: [String] = []
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
        payloadShapes[name] = try componentShape(payload)
      case "envelope":
        let inner = try required(row, "schema").text
        _ = try models.named(inner)
        payload = "ResponseEnvelope<\(inner)>"
        schema = nil
        stamps = []
        payloadShapes[name] =
          "Shape(kinds: [.object], required: [\"response\"], members: [\"response\": \(try componentShape(inner))])"
      case "storedEvent":
        storedEventChannels.append(name)
        _ = try models.schema(required(row, "payload").text)
        payload = row["enriched"] == .bool(true) ? "EnrichedResourceEvent" : "StoredEventResponse"
        schema = nil
        stamps = try self.stamps(models.schema(payload))
        payloadShapes[name] = try componentShape(payload)
      case "empty", "void":
        payload = "BusEmptyPayload"
        schema = nil
        stamps = []
        payloadShapes[name] = "Shape(kinds: [.object])"
      default: throw GenerationRefused(description: "unknown channel shape \(shape)")
      }
      rows[name] = (payload, schema)
      let channelType = scoped.contains(name) ? "ScopedChannel" : "Channel"
      out +=
        "  public static let \(escaped(memberName(name))): \(channelType)<\(payload)> = .init(name: \(literal(name)), stamps: Set([\(stamps.sorted().map(literal).joined(separator: ", "))]))\n"
    }
    guard scoped.union(everyone).isSubset(of: Set(rows.keys)) else {
      throw GenerationRefused(description: "audience names an unknown channel")
    }
    out += "}\npublic enum Operations {\n"
    var replies: Set<String> = []
    var limits: [String] = []
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
      if names[0].hasSuffix(":limits-requested") {
        limits.append(escaped(memberName(names[0])))
      }
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
        "  public static let \(escaped(memberName(names[0]))): Operation<\(channels.map(\.type).joined(separator: ", "))> = .init(request: Channels.\(escaped(memberName(names[0]))), result: Channels.\(escaped(memberName(names[1]))), failure: Channels.\(escaped(memberName(names[2]))), replyNames: [\(replyNames.map(literal).joined(separator: ", "))])\n"
    }
    out +=
      "  public static let limits: [Operation<InferenceLimitsRequest, InferenceLimitsResult, CommandError>] = [\(limits.joined(separator: ", "))]\n"
    out += "}\ninternal let wireOperations: [String: WireOperation] = [\n"
    for raw in try required(registry, "operations").array {
      let row = try raw.object
      let names = try ["request", "result", "failure"].map { try required(row, $0).text }
      guard let request = rows[names[0]], let response = rows[names[1]] else {
        throw GenerationRefused(description: "missing operation channels")
      }
      guard let failure = rows[names[2]], let failureSchema = failure.schema else {
        throw GenerationRefused(description: "failure channel has no schema")
      }
      let fields = try models.merged(failureSchema)["properties"]?.object ?? [:]
      let messages = ["message", "error"].filter { fields[$0] != nil }
      guard messages.count == 1, let message = messages.first else {
        throw GenerationRefused(description: "failure needs one message field")
      }
      let required = Set(
        try models.merged(failureSchema)["required"]?.array.map { try $0.text } ?? [])
      guard required.contains(message), let shape = fields[message],
        try models.nonnull(shape.object).0["type"] == .string("string")
      else {
        throw GenerationRefused(description: "failure message must be a required string")
      }
      out +=
        "  \(literal(names[0])): WireOperation(result: \(literal(names[1])), resultStamps: Channels.\(escaped(memberName(names[1]))).stamps, failure: \(literal(names[2])), request: { try projectWire(\(request.type).self, $0, stamps: Channels.\(escaped(memberName(names[0]))).stamps) }, response: { try projectWire(\(response.type).self, $0, stamps: Channels.\(escaped(memberName(names[1]))).stamps) }, decodeFailure: { try projectFailure(\(failure.type).self, $0, stamps: Channels.\(escaped(memberName(names[2]))).stamps, messageField: \(literal(message))) }),\n"
    }
    guard scoped.isDisjoint(with: everyone.union(replies)) else {
      throw GenerationRefused(description: "channel delivered both scoped and everywhere")
    }
    out +=
      "]\ninternal let bridgedChannels = [\(everyone.union(replies).sorted().map(literal).joined(separator: ", "))]\n"
    out +=
      "internal let storedEventChannels = [\(storedEventChannels.map(literal).joined(separator: ", "))]\n"
    out += shapeTable(
      "requiredSchemas", try schemaShapes.mapValues { try shapeLiteral($0) })
    out += shapeTable("requiredPayloadShapes", payloadShapes)
    out += try cacheRefreshTable(channels: Set(rows.keys))
    return out
  }
  /// client/refresh.json as typed rows: what each trigger does, and the ways into its event's
  /// payload, each split into the names of the members it is within and its own. A trigger is a
  /// channel of the registry, `reopened` or `unreadable`; which are channels is the registry's.
  func cacheRefreshTable(channels: Set<String>) throws -> String {
    let refresh = try table("client/refresh.json")
    let queries = try required(refresh, "queries").array.map {
      try required($0.object, "name").text
    }
    guard Set(queries).count == queries.count else {
      throw GenerationRefused(description: "duplicate cache query")
    }
    let reaches = ["subject", "held"]
    let kinds = ["enriched", "unenriched"]
    let acts = ["refetches", "writes", "removes"]
    let columns = ["on", "when", "reach", "names", "carries", "docs"] + acts
    var triggers: [String] = []
    var literals: [String] = []
    for raw in try required(refresh, "refresh").array {
      let row = try raw.object
      for key in row.keys.sorted() where !columns.contains(key) {
        throw GenerationRefused(description: "a refresh row states \(key), which is not read")
      }
      let trigger = try required(row, "on").text
      guard ["reopened", "unreadable"].contains(trigger) || channels.contains(trigger) else {
        throw GenerationRefused(description: "unknown cache refresh trigger \(trigger)")
      }
      if !triggers.contains(trigger) { triggers.append(trigger) }
      // The table's own reading: an absent reach is `subject`, absent names name nothing, and an
      // absent list of queries lists none.
      let reach = try row["reach"]?.text ?? "subject"
      guard reaches.contains(reach) else {
        throw GenerationRefused(description: "unknown refresh reach")
      }
      let when = try row["when"]?.text
      if let when, !kinds.contains(when) {
        throw GenerationRefused(description: "unknown refresh condition")
      }
      let names = try row["names"]?.object ?? [:]
      for slot in names.keys.sorted() where !["resource", "annotation"].contains(slot) {
        throw GenerationRefused(description: "a refresh row names a \(slot)")
      }
      var arguments = [
        "on: .\(escaped(enumCase(trigger)))",
        "when: \(when.map { ".\(escaped(enumCase($0)))" } ?? "nil")",
        "reach: .\(escaped(enumCase(reach)))",
        "resource: \(try wayLiteral(names["resource"]))",
        "annotation: \(try wayLiteral(names["annotation"]))",
        "carries: \(try wayLiteral(row["carries"]))",
      ]
      for key in acts {
        let listed = try row[key]?.array.map { try $0.text } ?? []
        for name in listed where !queries.contains(name) {
          throw GenerationRefused(description: "unknown cache query \(name)")
        }
        let cases = listed.map { ".\(escaped(enumCase($0)))" }
        arguments.append("\(key): [\(cases.joined(separator: ", "))]")
      }
      literals.append("  CacheRefreshRow(\(arguments.joined(separator: ", "))),\n")
    }
    var out = ""
    for (name, values) in [
      ("CacheQuery", queries), ("CacheRefreshTrigger", triggers), ("CacheRefreshWhen", kinds),
      ("CacheRefreshReach", reaches),
    ] {
      out +=
        try models.enumeration(name, values.map(JSONValue.string), ["type": .string("string")])
        .replacingOccurrences(of: "public ", with: "internal ") + "\n"
    }
    out += "internal protocol CacheQueryHandlers {\n"
    for query in queries { out += "  func \(escaped(memberName(query)))()\n" }
    out += "}\n"
    out +=
      """
      /// What one trigger does to the cache. `resource` and `annotation` are the ways into its
      /// event's payload to the keys a `subject` row reaches, and `carries` the way to the value
      /// it writes: each the names of the members it is within, and its own.
      internal struct CacheRefreshRow: Sendable {
        let on: CacheRefreshTrigger
        let when: CacheRefreshWhen?
        let reach: CacheRefreshReach
        let resource: [String]?
        let annotation: [String]?
        let carries: [String]?
        let refetches: [CacheQuery]
        let writes: [CacheQuery]
        let removes: [CacheQuery]
      }
      internal let cacheRefresh: [CacheRefreshRow] = [
      """ + "\n" + literals.joined() + "]\n"
    out += "/// The triggers that are channels of the bus, with the stamps each payload declares.\n"
    out += "internal let cacheRefreshChannels: [CacheRefreshTrigger: Set<String>] = [\n"
    for trigger in triggers where channels.contains(trigger) {
      out += "  .\(escaped(enumCase(trigger))): Channels.\(escaped(memberName(trigger))).stamps,\n"
    }
    return out + "]\n"
  }
  /// What session/stored.json says a client keeps, as Sources/Semiont/CachePersistence.swift reads
  /// it: the queries kept and the type each keeps, the key of a query per nothing, the version of a
  /// kept document, and the schema a kept place is held to. A document or a place of another shape
  /// than the one the persistence reads refuses generation.
  func keptTable() throws -> String {
    let stored = try table("session/stored.json")
    let queries = try required(table("client/refresh.json"), "queries").array.map {
      try required($0.object, "name").text
    }
    var kept: [String] = []
    var out = ""
    for raw in try required(stored, "keptQueries").array {
      let row = try raw.object
      for key in row.keys.sorted() where !["query", "value"].contains(key) {
        throw GenerationRefused(description: "a kept query states \(key), which is not read")
      }
      let query = try required(row, "query").text
      guard queries.contains(query), !kept.contains(query) else {
        throw GenerationRefused(
          description: "\(query) is kept twice, or is no query of client/refresh.json")
      }
      kept.append(query)
      let value = try storedType(required(row, "value").object, of: query)
      out += "internal typealias Kept\(pascal(query)) = \(value)\n"
    }
    let cases = kept.map { ".\(escaped(enumCase($0)))" }.joined(separator: ", ")
    out += "internal let keptQueries: Set<CacheQuery> = [\(cases)]\n"
    let whole = try required(required(stored, "wholeKey").object, "key").text
    out += "internal let wholeKey = \(literal(whole))\n"
    let version = try cacheDocumentVersion(required(stored, "cacheDocument").object)
    out += "internal let cacheDocumentVersion = \(version)\n"
    let places = try required(stored, "lastEventIds").object
    let scope = try storedType(required(places, "propertyNames").object, of: "lastEventIds")
    guard scope == "ResourceId" else {
      throw GenerationRefused(description: "places are kept by \(scope), which no scope is")
    }
    let place = componentName(
      try required(required(places, "additionalProperties").object, "$ref").text)
    guard try requiredShapes()[place] != nil else {
      throw GenerationRefused(description: "places are held to \(place), which no shape states")
    }
    return out + "internal let keptPlace = \(literal(place))\n"
  }
  /// The type a schema of session/stored.json refers to: a component schema, or one member of one.
  func storedType(_ schema: Schema, of owner: String) throws -> String {
    guard schema.count == 1, let ref = schema["$ref"] else {
      throw GenerationRefused(description: "\(owner) is no reference to a component schema")
    }
    let parts = try ref.text.split(separator: "#", omittingEmptySubsequences: false)
    let name = componentName(String(parts[0]))
    guard parts.count == 2 else { return try models.named(name) }
    let way = parts[1].split(separator: "/", omittingEmptySubsequences: false)
    guard way.count == 3, way[0].isEmpty, way[1] == "properties",
      let member = try required(models.schema(name), "properties").object[String(way[2])]
    else {
      throw GenerationRefused(description: "\(owner) refers to no member of \(name)")
    }
    return try models.type(name, String(way[2]), member.object)
  }
  func componentName(_ path: String) -> String {
    URL(fileURLWithPath: path).deletingPathExtension().lastPathComponent
  }
  /// The version of a kept document, whose every entry is a key, a value and a stamp that is a
  /// whole number of at least 0.
  func cacheDocumentVersion(_ document: Schema) throws -> Int {
    let properties = try required(document, "properties").object
    let members = try required(document, "required").array.map { try $0.text }
    let items = try required(required(properties, "entries").object, "items").object
    let parts = try required(items, "prefixItems").array
    guard Set(properties.keys) == ["version", "entries"], Set(members) == Set(properties.keys),
      parts.count == 3, items["minItems"] == .number(3), items["maxItems"] == .number(3),
      try parts[2].object["type"] == .string("integer"),
      try parts[2].object["minimum"] == .number(0),
      case .number(let version) = try required(required(properties, "version").object, "const"),
      let integer = Int(exactly: version)
    else {
      throw GenerationRefused(
        description:
          "session/stored.json's cacheDocument is not the document Sources/Semiont/CachePersistence.swift reads"
      )
    }
    return integer
  }
  /// A way into an event's payload, as the names it is made of; nil where the row states none.
  func wayLiteral(_ raw: JSONValue?) throws -> String {
    guard let raw else { return "nil" }
    let names = try raw.text.split(separator: ".", omittingEmptySubsequences: false)
    guard names.allSatisfy({ !$0.isEmpty }) else {
      throw GenerationRefused(description: "\(raw) is no way to a member")
    }
    return "[\(names.map { literal(String($0)) }.joined(separator: ", "))]"
  }
}
