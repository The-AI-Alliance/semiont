import Foundation

package struct GenerationRefused: Error, CustomStringConvertible {
  package let description: String
  package init(description: String) { self.description = description }
}

typealias Schema = [String: JSONValue]

func generateModels(_ definitions: [String: String]) throws -> String {
  let decoded = try definitions.mapValues {
    try JSONDecoder().decode(JSONValue.self, from: Data($0.utf8))
  }
  return try ModelGenerator(definitions: decoded, identifiers: []).generate()
}

package final class ModelGenerator {
  let definitions: [String: JSONValue]
  let identifiers: Set<String>
  var written: [String: String] = [:]

  package init(definitions: [String: JSONValue], identifiers: Set<String>) {
    self.definitions = definitions
    self.identifiers = identifiers
  }

  func refuse(_ message: String) throws -> Never { throw GenerationRefused(description: message) }
  func schema(_ name: String) throws -> Schema {
    guard let value = definitions[name] else { try refuse("no schema \(name)") }
    return try value.object
  }
  package func generate() throws -> String {
    for name in definitions.keys.sorted() { _ = try named(name) }
    return "// Generated from specs/src; do not edit.\nimport Foundation\n\n"
      + written.sorted(by: { $0.key < $1.key }).map(\.value).joined(separator: "\n\n") + "\n"
  }
  func named(_ name: String) throws -> String {
    if written[name] == nil {
      written[name] = ""
      written[name] = try declaration(name, schema(name))
    }
    return name
  }
  func inline(_ owner: String, _ part: String, _ schema: Schema) throws -> String {
    var name = owner + pascal(part)
    while definitions[name] != nil { name += "Value" }
    let code = try declaration(name, schema)
    if let old = written[name], old != code {
      try refuse("two different inline schemas named \(name)")
    }
    written[name] = code
    return name
  }
  func validate(_ schema: Schema) throws {
    let known: Set<String> = [
      "$ref", "type", "properties", "required", "items", "additionalProperties", "oneOf", "anyOf",
      "allOf", "enum", "nullable", "discriminator", "description", "title", "format", "default",
      "example",
      "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems", "maxProperties",
      "pattern", "uniqueItems",
    ]
    let unsupported = Set(schema.keys).subtracting(known)
    guard unsupported.isEmpty else {
      try refuse("unsupported schema keywords: \(unsupported.sorted())")
    }
  }
  func nonnull(_ raw: Schema) throws -> (Schema, Bool) {
    var schema = raw
    if schema.removeValue(forKey: "nullable") == .bool(true) { return (schema, true) }
    if let types = schema["type"], case .array(let names) = types {
      let others = names.filter { $0 != .string("null") }
      guard others.count == 1, others.count != names.count else {
        try refuse("unsupported schema types \(names)")
      }
      schema["type"] = others[0]
      return (schema, true)
    }
    return (schema, false)
  }
  func type(_ owner: String, _ part: String, _ raw: Schema) throws -> String {
    try validate(raw)
    let (s, _) = try nonnull(raw)
    if s["const"] != nil { try refuse("\(owner).\(part): const is not OpenAPI 3.0") }
    if let ref = s["$ref"] { return try named(ref.text) }
    if s.isEmpty { return "JSONValue" }
    if let all = s["allOf"], try all.array.count == 1, let ref = try all.array[0].object["$ref"] {
      return try named(ref.text)
    }
    if s["oneOf"] != nil || s["anyOf"] != nil || s["allOf"] != nil {
      return try inline(owner, part, s)
    }
    guard let kind = s["type"] else { try refuse("\(owner).\(part): schema without a type") }
    switch try kind.text {
    case "string":
      if let format = s["format"],
        !["date-time", "uri", "uuid", "email", "binary"].contains(try format.text)
      {
        try refuse("\(owner).\(part): unsupported format \(format)")
      }
      return s["enum"] == nil ? "String" : try inline(owner, part, s)
    case "integer": return s["enum"] == nil ? "Int" : try inline(owner, part, s)
    case "number": return "Double"
    case "boolean": return s["enum"] == nil ? "Bool" : try inline(owner, part, s)
    case "array":
      guard let item = s["items"] else { try refuse("\(owner).\(part): array without items") }
      return "[\(try type(owner, part + "Item", item.object))]"
    case "object":
      if s["properties"] == nil {
        if let additional = s["additionalProperties"], case .object(let value) = additional {
          return "[String: \(try type(owner, part + "Value", value))]"
        }
        if s["additionalProperties"] == .bool(true) { return "[String: JSONValue]" }
      }
      return try inline(owner, part, s)
    default: try refuse("\(owner).\(part): unsupported type \(kind)")
    }
  }
  func merged(_ s: Schema) throws -> Schema {
    guard let members = s["allOf"] else { return s }
    var properties: Schema = [:]
    var required: Set<String> = []
    var closed = false
    for raw in try members.array {
      var member = try raw.object
      if let ref = member["$ref"] { member = try schema(ref.text) }
      member = try merged(member)
      guard member["type"] == .string("object") else { try refuse("allOf member is not an object") }
      if let p = member["properties"] { properties.merge(try p.object) { _, right in right } }
      if let r = member["required"] { required.formUnion(try r.array.map { try $0.text }) }
      closed = closed || member["additionalProperties"] == .bool(false)
    }
    var result: Schema = [
      "type": .string("object"), "properties": .object(properties),
      "required": .array(required.sorted().map(JSONValue.string)),
    ]
    if closed { result["additionalProperties"] = .bool(false) }
    return result
  }
  func declaration(_ name: String, _ raw: Schema) throws -> String {
    try validate(raw)
    let (s, _) = try nonnull(raw)
    if s["const"] != nil { try refuse("\(name): const is not OpenAPI 3.0") }
    if identifiers.contains(name) { return try identifier(name, s) }
    if let ref = s["$ref"] { return "public typealias \(name) = \(try named(ref.text))" }
    if let all = s["allOf"], try all.array.count == 1, let ref = try all.array[0].object["$ref"] {
      return "public typealias \(name) = \(try named(ref.text))"
    }
    if s["allOf"] != nil { return try object(name, merged(s)) }
    if let union = s["oneOf"] ?? s["anyOf"] { return try unionDeclaration(name, union.array, s) }
    if let values = s["enum"] { return try enumeration(name, values.array, s) }
    guard let kind = s["type"] else { try refuse("\(name): schema without a type") }
    switch try kind.text {
    case "object":
      if s["properties"] == nil, let additional = s["additionalProperties"] {
        if additional == .bool(true) { return "public typealias \(name) = [String: JSONValue]" }
        if case .object(let map) = additional {
          return "public typealias \(name) = [String: \(try type(name, "Value", map))]"
        }
      }
      return try object(name, s)
    case "string": return "public typealias \(name) = String"
    case "integer": return "public typealias \(name) = Int"
    case "number": return "public typealias \(name) = Double"
    case "boolean": return "public typealias \(name) = Bool"
    case "array":
      guard let item = s["items"] else { try refuse("\(name): array without items") }
      return "public typealias \(name) = [\(try type(name, "Item", item.object))]"
    default: try refuse("\(name): unsupported schema \(kind)")
    }
  }
  func enumeration(_ name: String, _ values: [JSONValue], _ s: Schema) throws -> String {
    guard !values.isEmpty else { try refuse("\(name): empty enumeration") }
    if s["type"] == .string("string") {
      var names: Set<String> = []
      let cases = try values.map { value in
        let text = try value.text
        let label = enumCase(text)
        guard names.insert(label).inserted else {
          try refuse("\(name): duplicate Swift enum case \(label)")
        }
        return "  case \(escaped(label)) = \(literal(text))"
      }
      return
        "public enum \(name): String, Codable, Sendable, CaseIterable {\n\(cases.joined(separator: "\n"))\n}"
    }
    guard values.count == 1 else { try refuse("\(name): unsupported non-string enumeration") }
    let underlying: String
    let value: String
    switch values[0] {
    case .number(let n) where n.rounded() == n:
      underlying = "Int"
      value = String(Int(n))
    case .bool(let b):
      underlying = "Bool"
      value = String(b)
    default: try refuse("\(name): unsupported enumeration \(values)")
    }
    return """
      public enum \(name): Codable, Sendable {
        case value
        public init(from decoder: any Decoder) throws {
          let c = try decoder.singleValueContainer()
          guard try c.decode(\(underlying).self) == \(value) else { throw DecodingError.dataCorruptedError(in: c, debugDescription: \(literal(name))) }
          self = .value
        }
        public func encode(to encoder: any Encoder) throws {
          var c = encoder.singleValueContainer()
          try c.encode(\(value))
        }
      }
      """
  }
  func object(_ name: String, _ s: Schema) throws -> String {
    let properties = try s["properties"]?.object ?? [:]
    let required = Set(try s["required"]?.array.map { try $0.text } ?? [])
    let open = s["additionalProperties"] == .bool(true)
    let closed = s["additionalProperties"] == .bool(false) || s["maxProperties"] == .number(0)
    if let extra = s["additionalProperties"], case .object = extra {
      try refuse("\(name): named and typed additional properties are unsupported")
    }
    struct Property {
      let wire: String
      let member: String
      let type: String
      let required: Bool
      let nullable: Bool
      let constant: String?
      var declared: String {
        !required && nullable ? "Stated<\(type)>" : !required || nullable ? "\(type)?" : type
      }
    }
    var fields: [Property] = []
    var seen: Set<String> = []
    for (wire, raw) in properties.sorted(by: { $0.key < $1.key }) {
      let member = memberName(wire)
      let schema = try raw.object
      guard seen.insert(member).inserted, !open || member != "rest" else {
        try refuse("\(name): duplicate or reserved property \(member)")
      }
      let constant: String?
      if required.contains(wire), try !nonnull(schema).1, let values = try schema["enum"]?.array,
        values.count == 1
      {
        if case .string(let text) = values[0] {
          constant = "." + escaped(enumCase(text))
        } else {
          constant = ".value"
        }
      } else {
        constant = nil
      }
      fields.append(
        Property(
          wire: wire, member: member, type: try type(name, wire, schema),
          required: required.contains(wire), nullable: try nonnull(schema).1, constant: constant))
    }
    var out = "public struct \(name): Codable, Sendable {\n"
    for field in fields {
      out +=
        "  public \(field.constant == nil ? "var" : "let") \(escaped(field.member)): \(field.declared)\n"
    }
    if open { out += "  public var rest: [String: JSONValue]\n" }
    let params =
      fields.filter { $0.constant == nil }.map { f in
        "\(escaped(f.member)): \(f.declared)"
          + (f.required ? "" : f.nullable ? " = .absent" : " = nil")
      } + (open ? ["rest: [String: JSONValue] = [:]"] : [])
    out += "  public init(\(params.joined(separator: ", "))) {\n"
    for field in fields {
      out += "    self.\(escaped(field.member)) = \(field.constant ?? escaped(field.member))\n"
    }
    if open { out += "    self.rest = rest\n" }
    out += "  }\n  public init(from decoder: any Decoder) throws {\n"
    if !fields.isEmpty || open || closed {
      out += "    let c = try decoder.container(keyedBy: WireKey.self)\n"
    } else {
      out += "    _ = try decoder.container(keyedBy: WireKey.self)\n"
    }
    let known = "Set<String>([\(fields.map { literal($0.wire) }.joined(separator: ", "))])"
    if closed {
      out +=
        "    if let key = c.allKeys.first(where: { !\(known).contains($0.stringValue) }) { throw DecodingError.dataCorruptedError(forKey: key, in: c, debugDescription: \(literal("unknown property in " + name))) }\n"
    }
    for f in fields {
      let key = "WireKey(\(literal(f.wire)))"
      let target = "self.\(escaped(f.member))"
      if f.required {
        out +=
          "    \(target) = try c.decode(\(f.nullable ? "Optional<\(f.type)>" : f.type).self, forKey: \(key))\n"
      } else if f.nullable {
        out +=
          "    if !c.contains(\(key)) { \(target) = .absent } else if try c.decodeNil(forKey: \(key)) { \(target) = .null } else { \(target) = .value(try c.decode(\(f.type).self, forKey: \(key))) }\n"
      } else {
        out +=
          "    \(target) = c.contains(\(key)) ? try c.decode(\(f.type).self, forKey: \(key)) : nil\n"
      }
    }
    if open {
      out +=
        "    rest = [:]\n    for key in c.allKeys where !\(known).contains(key.stringValue) { rest[key.stringValue] = try c.decode(JSONValue.self, forKey: key) }\n"
    }
    out += "  }\n  public func encode(to encoder: any Encoder) throws {\n"
    out +=
      !fields.isEmpty || open
      ? "    var c = encoder.container(keyedBy: WireKey.self)\n"
      : "    _ = encoder.container(keyedBy: WireKey.self)\n"
    if open {
      out +=
        "    for (key, value) in rest { guard !\(known).contains(key) else { throw EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: \(literal("rest overrides a named property of " + name)))) }; try c.encode(value, forKey: WireKey(key)) }\n"
    }
    for f in fields {
      let key = "WireKey(\(literal(f.wire)))"
      let value = "self.\(escaped(f.member))"
      if f.required {
        out += "    try c.encode(\(value), forKey: \(key))\n"
      } else if f.nullable {
        out +=
          "    switch \(value) { case .absent: break; case .null: try c.encodeNil(forKey: \(key)); case .value(let value): try c.encode(value, forKey: \(key)) }\n"
      } else {
        out += "    try c.encodeIfPresent(\(value), forKey: \(key))\n"
      }
    }
    return out + "  }\n}"
  }
  func unionDeclaration(_ name: String, _ members: [JSONValue], _ s: Schema) throws -> String {
    guard !members.isEmpty else { try refuse("\(name): empty union") }
    var variants: [(label: String, type: String, schema: Schema)] = []
    var labels: Set<String> = []
    let discriminator = try s["discriminator"]?.object["propertyName"]?.text
    for (index, raw) in members.enumerated() {
      let schema = try raw.object
      var resolved = schema
      if let ref = schema["$ref"] { resolved = try self.schema(ref.text) }
      resolved = try merged(resolved)
      let tag: String?
      if let discriminator, let prop = try resolved["properties"]?.object[discriminator],
        let values = try prop.object["enum"]?.array, values.count == 1
      {
        tag = try values[0].text
      } else {
        tag = nil
      }
      let part: String
      if let ref = schema["$ref"] {
        part = try ref.text
      } else if let tag {
        part = pascal(tag)
      } else if resolved["type"] == .string("string") {
        part = "Text"
      } else if resolved["type"] == .string("array") {
        part = "List"
      } else if resolved["type"] == .string("object"), resolved["properties"] == nil {
        part = "Empty"
      } else {
        let properties = try resolved["properties"]?.object ?? [:]
        let constants = try properties.sorted(by: { $0.key < $1.key }).compactMap {
          pair -> String? in
          guard let values = try pair.value.object["enum"]?.array, values.count == 1,
            case .string(let text) = values[0]
          else { return nil }
          return text
        }
        if let tag = constants.first {
          part = pascal(tag)
        } else if resolved["type"] == .string("object") {
          part = "Object"
        } else {
          try refuse("\(name): union member \(index) has no stable name")
        }
      }
      let label = part.prefix(1).lowercased() + part.dropFirst()
      guard labels.insert(label).inserted else {
        try refuse("\(name): two union members named \(label)")
      }
      let memberType = try type(name, part, schema)
      variants.append((label, memberType, resolved))
    }
    var out = "public indirect enum \(name): Codable, Sendable {\n"
    for v in variants { out += "  case \(escaped(v.label))(\(v.type))\n" }
    out += "  public init(from decoder: any Decoder) throws {\n"
    if let discriminator {
      out +=
        "    let c = try decoder.container(keyedBy: WireKey.self)\n    let tag = try c.decode(String.self, forKey: WireKey(\(literal(discriminator))))\n    switch tag {\n"
      var tags: Set<String> = []
      for v in variants {
        guard let property = try v.schema["properties"]?.object[discriminator],
          let values = try property.object["enum"]?.array, !values.isEmpty
        else { try refuse("\(name): discriminator missing in \(v.type)") }
        let labels = try values.map { value in
          let tag = try value.text
          guard tags.insert(tag).inserted else {
            try refuse("\(name): duplicate discriminator \(tag)")
          }
          return literal(tag)
        }
        out +=
          "    case \(labels.joined(separator: ", ")): self = .\(escaped(v.label))(try \(v.type)(from: decoder))\n"
      }
      out +=
        "    default: throw DecodingError.dataCorruptedError(forKey: WireKey(\(literal(discriminator))), in: c, debugDescription: \(literal("unknown " + name + " discriminator")))\n    }\n"
    } else {
      for v in variants {
        out +=
          "    if let value = try? \(v.type)(from: decoder) { self = .\(escaped(v.label))(value); return }\n"
      }
      out +=
        "    throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: \(literal("no member of " + name + " fits"))))\n"
    }
    out += "  }\n  public func encode(to encoder: any Encoder) throws {\n    switch self {\n"
    for v in variants {
      out += "    case .\(escaped(v.label))(let value): try value.encode(to: encoder)\n"
    }
    return out + "    }\n  }\n}"
  }
  func identifier(_ name: String, _ s: Schema) throws -> String {
    guard s["type"] == .string("string"), let raw = s["pattern"] else {
      try refuse("\(name): identifier without a string pattern")
    }
    let pattern = try raw.text
    guard pattern.hasPrefix("^"), pattern.hasSuffix("$") else {
      try refuse("\(name): identifier pattern is not anchored")
    }
    let body = String(pattern.dropFirst().dropLast())
    guard let start = body.firstIndex(where: { $0 == "[" || $0 == "\\" }) else {
      try refuse("\(name): unsupported identifier pattern")
    }
    let prefix = String(body[..<start])
    let rest = String(body[start...])
    guard prefix.allSatisfy({ !$0.isWhitespace && !".|?*+(){}^$]".contains($0) }) else {
      try refuse("\(name): unsupported identifier prefix")
    }
    let predicate: String
    let times: String
    if rest.hasPrefix("\\S") {
      predicate =
        "!(c.value == 9 || c.value == 10 || c.value == 11 || c.value == 12 || c.value == 13 || c.value == 32 || c.value == 160 || c.value == 5760 || (8192...8202).contains(c.value) || c.value == 8232 || c.value == 8233 || c.value == 8239 || c.value == 8287 || c.value == 12288 || c.value == 65279)"
      times = String(rest.dropFirst(2))
    } else {
      guard rest.hasPrefix("["), let end = rest.firstIndex(of: "]") else {
        try refuse("\(name): unsupported identifier character set")
      }
      let characters = Array(rest[rest.index(after: rest.startIndex)..<end].unicodeScalars)
      var terms: [String] = []
      var i = 0
      while i < characters.count {
        let c = characters[i].value
        guard ![94, 92, 91].contains(c) else {
          try refuse("\(name): unsupported identifier character set")
        }
        if i + 2 < characters.count, characters[i + 1].value == 45 {
          terms.append("(\(c)...\(characters[i + 2].value)).contains(c.value)")
          i += 3
        } else {
          terms.append("c.value == \(c)")
          i += 1
        }
      }
      guard !terms.isEmpty else { try refuse("\(name): empty identifier character set") }
      predicate = terms.joined(separator: " || ")
      times = String(rest[rest.index(after: end)...])
    }
    let low: Int
    let high: Int?
    if times == "+" {
      low = 1
      high = nil
    } else if times == "*" {
      low = 0
      high = nil
    } else if times.hasPrefix("{"), times.hasSuffix("}") {
      let parts = times.dropFirst().dropLast().split(
        separator: ",", omittingEmptySubsequences: false)
      guard (1...2).contains(parts.count), let min = Int(parts[0]), min >= 0 else {
        try refuse("\(name): invalid identifier repetition")
      }
      low = min
      if parts.count == 1 {
        high = low
      } else if parts[1].isEmpty {
        high = nil
      } else {
        guard let max = Int(parts[1]), max >= low else {
          try refuse("\(name): invalid identifier repetition")
        }
        high = max
      }
    } else {
      try refuse("\(name): unsupported identifier repetition")
    }
    let count = "scalars.count >= \(low)" + (high.map { " && scalars.count <= \($0)" } ?? "")
    return """
      public struct \(name): Hashable, Sendable, Codable, CustomStringConvertible {
        public let value: String
        public var description: String { value }
        public init(_ value: String) throws {
          guard value.unicodeScalars.starts(with: \(literal(prefix)).unicodeScalars) else { throw InvalidIdentifier(kind: \(literal(name)), pattern: \(literal(pattern)), value: value) }
          let scalars = value.unicodeScalars.dropFirst(\(prefix.unicodeScalars.count))
          guard \(count), scalars.allSatisfy({ c in \(predicate) }) else { throw InvalidIdentifier(kind: \(literal(name)), pattern: \(literal(pattern)), value: value) }
          self.value = value
        }
        public static func parse(_ value: String) -> Self? { try? Self(value) }
        public static func == (lhs: Self, rhs: Self) -> Bool { lhs.value.utf8.elementsEqual(rhs.value.utf8) }
        public func hash(into hasher: inout Hasher) { for byte in value.utf8 { hasher.combine(byte) } }
        public init(from decoder: any Decoder) throws {
          let c = try decoder.singleValueContainer()
          let value = try c.decode(String.self)
          do { try self.init(value) } catch { throw DecodingError.dataCorruptedError(in: c, debugDescription: String(describing: error)) }
        }
        public func encode(to encoder: any Encoder) throws { var c = encoder.singleValueContainer(); try c.encode(value) }
      }
      """
  }
}
