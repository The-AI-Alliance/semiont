import Foundation
import Testing

@testable import Semiont

enum Spec {
  static var repository: URL {
    URL(fileURLWithPath: #filePath).deletingLastPathComponent()
      .appendingPathComponent("../../../../..").standardizedFileURL
  }
  static func read(_ relative: String) throws -> JSONValue {
    try JSONDecoder().decode(
      JSONValue.self,
      from: Data(contentsOf: repository.appendingPathComponent("protocol/specs/src/" + relative)))
  }
  static func jsonFiles(_ relative: String) throws -> [URL] {
    let directory = repository.appendingPathComponent(relative)
    guard
      let contents = FileManager.default.enumerator(at: directory, includingPropertiesForKeys: nil)
    else {
      throw SpecFailure.missingDirectory(directory.path)
    }
    return contents.compactMap { $0 as? URL }.filter { $0.pathExtension == "json" }.sorted {
      $0.path < $1.path
    }
  }
}
enum SpecFailure: Error {
  case missingDirectory(String)
  case shape(String)
}

extension JSONValue {
  var object: [String: JSONValue] {
    get throws {
      guard case .object(let value) = self else { throw SpecFailure.shape("expected object") }
      return value
    }
  }
  var array: [JSONValue] {
    get throws {
      guard case .array(let value) = self else { throw SpecFailure.shape("expected array") }
      return value
    }
  }
  var text: String {
    get throws {
      guard case .string(let value) = self else { throw SpecFailure.shape("expected text") }
      return value
    }
  }
}
func required(_ object: [String: JSONValue], _ key: String) throws -> JSONValue {
  guard let value = object[key] else { throw SpecFailure.shape("missing \(key)") }
  return value
}
