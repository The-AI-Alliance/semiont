import Foundation

extension JSONValue {
  package var object: [String: JSONValue] {
    get throws {
      guard case .object(let value) = self else {
        throw GenerationRefused(description: "expected an object, found \(self)")
      }
      return value
    }
  }
  package var array: [JSONValue] {
    get throws {
      guard case .array(let value) = self else {
        throw GenerationRefused(description: "expected a list, found \(self)")
      }
      return value
    }
  }
  package var text: String {
    get throws {
      guard case .string(let value) = self else {
        throw GenerationRefused(description: "expected text, found \(self)")
      }
      return value
    }
  }
}

package func loadJSON(_ file: URL) throws -> JSONValue {
  try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: file))
}

func literal(_ text: String) -> String {
  // Swift interpolation must stay text in the generated source.
  var result = "\""
  for scalar in text.unicodeScalars {
    switch scalar.value {
    case 34: result += "\\\""
    case 92: result += "\\\\"
    case 0...31, 127...159: result += "\\u{\(String(scalar.value, radix: 16))}"
    default: result.unicodeScalars.append(scalar)
    }
  }
  return result + "\""
}

func pascal(_ text: String) -> String {
  text.split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map {
    $0.prefix(1).uppercased() + $0.dropFirst()
  }.joined()
}
func memberName(_ text: String) -> String {
  let pieces = text.split(whereSeparator: { !$0.isLetter && !$0.isNumber && $0 != "_" })
  guard let first = pieces.first else { return "value" }
  let name =
    String(first) + pieces.dropFirst().map { $0.prefix(1).uppercased() + $0.dropFirst() }.joined()
  return name.first?.isNumber == true ? "value" + name : name
}
func escaped(_ text: String) -> String { "`\(text)`" }

/// Resolve whole-file references to canonical named schemas. No generated bundle is an input.
package func loadDefinitions(_ specs: URL) throws -> [String: JSONValue] {
  let root = try loadJSON(specs.appendingPathComponent("openapi.json")).object
  guard let components = root["components"], let schemas = try components.object["schemas"] else {
    throw GenerationRefused(description: "openapi.json has no component schemas")
  }
  var definitions: [String: JSONValue] = [:]
  var names: [URL: String] = [:]
  var pending: [(String, URL)] = []
  for (name, entry) in try schemas.object.sorted(by: { $0.key < $1.key }) {
    guard let ref = try entry.object["$ref"] else {
      throw GenerationRefused(description: "\(name) has no schema file")
    }
    let file = specs.appendingPathComponent(try ref.text).standardizedFileURL
    names[file] = name
    pending.append((name, file))
  }
  func resolve(_ value: JSONValue, base: URL) throws -> JSONValue {
    switch value {
    case .array(let array): return .array(try array.map { try resolve($0, base: base) })
    case .object(let object):
      if let ref = object["$ref"] {
        let path = try ref.text
        guard !path.contains("#") else {
          throw GenerationRefused(description: "unsupported reference \(path)")
        }
        let file = base.appendingPathComponent(path).standardizedFileURL
        if names[file] == nil {
          let name = file.deletingPathExtension().lastPathComponent
          guard !names.values.contains(name) else {
            throw GenerationRefused(description: "duplicate schema name \(name)")
          }
          names[file] = name
          pending.append((name, file))
        }
        guard let name = names[file] else {
          throw GenerationRefused(description: "unresolved \(file)")
        }
        var result = object
        result["$ref"] = .string(name)
        return .object(result)
      }
      return .object(try object.mapValues { try resolve($0, base: base) })
    default: return value
    }
  }
  let signIn = specs.appendingPathComponent("sign-in-store/SignIn.json")
  names[signIn] = "SignIn"
  pending.append(("SignIn", signIn))
  var index = 0
  while index < pending.count {
    let (name, file) = pending[index]
    index += 1
    guard definitions[name] == nil else { continue }
    definitions[name] = try resolve(loadJSON(file), base: file.deletingLastPathComponent())
  }
  return definitions
}

func enumCase(_ text: String) -> String {
  let name = memberName(text.replacingOccurrences(of: "+", with: " Plus "))
  return name.prefix(1).lowercased() + name.dropFirst()
}
