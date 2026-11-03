import Foundation

func shownOnBus(_ value: JSONValue) -> JSONValue {
  switch value {
  case .object(let object):
    .object(
      object.reduce(into: [:]) { result, item in
        result[item.key] =
          credentialNames.contains(item.key) ? .string("[withheld]") : shownOnBus(item.value)
      })
  case .array(let values): .array(values.map(shownOnBus))
  default: value
  }
}
struct BusLog {
  private static let enabled =
    ProcessInfo.processInfo.environment["SEMIONT_BUS_LOG"].map { !$0.isEmpty } ?? false
  static func line(
    _ operation: String, channel: String, payload: [String: JSONValue], scope: ResourceId?,
    correlationID: String?, traceID: String? = nil
  ) {
    guard enabled else { return }
    let encoder = JSONEncoder()
    encoder.outputFormatting = .sortedKeys
    guard let data = try? encoder.encode(shownOnBus(.object(payload))) else { return }
    var line = "[bus \(operation)] \(channel)"
    if let scope { line += " scope=\(scope.value)" }
    if let correlationID, !correlationID.isEmpty { line += " cid=\(correlationID.prefix(8))" }
    if let traceID { line += " trace=\(traceID.prefix(8))" }
    line += " " + String(decoding: data, as: UTF8.self) + "\n"
    FileHandle.standardOutput.write(Data(line.utf8))
  }
}
