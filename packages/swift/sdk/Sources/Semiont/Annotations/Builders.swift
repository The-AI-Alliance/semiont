import Crypto
import Foundation

public struct SpanRefusedError: Error, Sendable {
  public let reason: SpanRefusalErrorCode
  public let message: String
  public var code: String { reason.rawValue }
}
public enum Spanned: Sendable {
  case text(String)
  case anchored(AnchoredText)
}
public struct OfSpan: Sendable {
  public let resourceId: ResourceId
  public let motivation: Motivation
  public let generator: Agent
  public let span: TextSpan
  public let body: AnnotationBodies?
  public let text: Spanned
  public init(
    resourceId: ResourceId, motivation: Motivation, generator: Agent, span: TextSpan,
    body: AnnotationBodies? = nil, text: Spanned
  ) {
    self.resourceId = resourceId
    self.motivation = motivation
    self.generator = generator
    self.span = span
    self.body = body
    self.text = text
  }
}
public struct OfResource: Sendable {
  public let resourceId: ResourceId
  public let motivation: Motivation
  public let generator: Agent?
  public let body: AnnotationBodies?
  public init(
    resourceId: ResourceId, motivation: Motivation, generator: Agent? = nil,
    body: AnnotationBodies? = nil
  ) {
    self.resourceId = resourceId
    self.motivation = motivation
    self.generator = generator
    self.body = body
  }
}
enum AnnotationIdentityError: Error { case nonWholeNumber }
func canonicalAnnotationJSON(_ value: JSONValue) throws -> String {
  switch value {
  case .null: return "null"
  case .bool(let flag): return flag ? "true" : "false"
  case .number(let number):
    guard number.isFinite, number.rounded(.towardZero) == number else {
      throw AnnotationIdentityError.nonWholeNumber
    }
    return number == 0
      ? "0" : String(format: "%.0f", locale: Locale(identifier: "en_US_POSIX"), number)
  case .string(let text):
    var escaped = "\""
    for point in text.unicodeScalars {
      switch point.value {
      case 8: escaped += "\\b"
      case 9: escaped += "\\t"
      case 10: escaped += "\\n"
      case 12: escaped += "\\f"
      case 13: escaped += "\\r"
      case 34: escaped += "\\\""
      case 92: escaped += "\\\\"
      case 0..<32: escaped += String(format: "\\u%04x", point.value)
      default: escaped.unicodeScalars.append(point)
      }
    }
    return escaped + "\""
  case .array(let items):
    return "[" + (try items.map(canonicalAnnotationJSON).joined(separator: ",")) + "]"
  case .object(let members):
    let ordered = members.keys.sorted {
      $0.unicodeScalars.lexicographicallyPrecedes($1.unicodeScalars)
    }
    return "{"
      + (try ordered.map { key in
        guard let value = members[key] else {
          throw EncodingError.invalidValue(
            key, .init(codingPath: [], debugDescription: "Missing member"))
        }
        return try canonicalAnnotationJSON(.string(key)) + ":" + canonicalAnnotationJSON(value)
      }.joined(separator: ",")) + "}"
  }
}
func annotationID(resourceId: ResourceId, motivation: Motivation, anchor: String, body: JSONValue?)
  throws -> AnnotationId
{
  var identity: [String: JSONValue] = [
    "resourceId": .string(resourceId.value), "motivation": .string(motivation.rawValue),
    "anchor": .string(anchor),
  ]
  identity["body"] = body
  let text = try canonicalAnnotationJSON(.object(identity))
  let digest = Data(SHA256.hash(data: Data(text.utf8)))
  return try AnnotationId(String(base64URL(digest).prefix(21)))
}
private func built(
  target: AnnotationTarget, motivation: Motivation, anchor: String, generator: Agent?,
  body: AnnotationBodies?
) throws -> Annotation {
  let written = try body.map {
    try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode($0))
  }
  return Annotation(
    body: body,
    created: Date().ISO8601Format(.iso8601(timeZone: .gmt, includingFractionalSeconds: true)),
    generator: generator.map { .agent($0) },
    id: try annotationID(
      resourceId: target.source, motivation: motivation, anchor: anchor, body: written),
    motivation: motivation, target: .annotationTarget(target))
}
private func validSpan(_ start: Int, _ end: Int, _ length: Int) -> Bool {
  start >= 0 && start <= end && end <= length
}
private func refused(_ reason: SpanRefusalErrorCode) -> SpanRefusedError {
  SpanRefusedError(reason: reason, message: reason.rawValue)
}
public func annotationOfSpan(_ of: OfSpan) throws -> Annotation {
  let text: ScalarText
  let pdf: AnchoredText?
  switch of.text {
  case .text(let value):
    text = ScalarText(value)
    pdf = nil
  case .anchored(let value):
    text = ScalarText(value.text)
    pdf = value
  }
  if let anchored = pdf {
    for item in anchored.items where !validSpan(item.start, item.end, text.count) {
      throw refused(.itemOutOfRange)
    }
  }
  let span = of.span
  guard validSpan(span.start, span.end, text.count) else { throw refused(.spanOutOfRange) }
  var selectors: [Selector]
  if let anchored = pdf {
    let (overlapping, rectangles) = locate(anchored, start: span.start, end: span.end)
    guard !rectangles.isEmpty, let first = overlapping.map(\.start).min(),
      let last = overlapping.map(\.end).max()
    else { throw refused(.nothingLocated) }
    guard ScalarText(collapsed(text.text(first, last))).contains(collapsed(span.exact)) else {
      throw refused(.exactNotCovered)
    }
    selectors = rectangles.map {
      .fragmentSelector(
        FragmentSelector(conformsTo: "http://tools.ietf.org/rfc/rfc3778", value: fragmentOf($0)))
    }
  } else {
    guard text.text(span.start, span.end).unicodeScalars.elementsEqual(span.exact.unicodeScalars)
    else { throw refused(.exactMismatch) }
    selectors = [.textPositionSelector(TextPositionSelector(end: span.end, start: span.start))]
  }
  if let prefix = span.prefix,
    !Array(text.points[..<span.start]).suffix(prefix.unicodeScalars.count).elementsEqual(
      prefix.unicodeScalars)
  {
    throw refused(.prefixMismatch)
  }
  if let suffix = span.suffix,
    !Array(text.points[span.end...]).prefix(suffix.unicodeScalars.count).elementsEqual(
      suffix.unicodeScalars)
  {
    throw refused(.suffixMismatch)
  }
  selectors.append(
    .textQuoteSelector(
      TextQuoteSelector(
        exact: span.exact, prefix: span.prefix.flatMap { $0.isEmpty ? nil : $0 },
        suffix: span.suffix.flatMap { $0.isEmpty ? nil : $0 })))
  return try built(
    target: AnnotationTarget(
      selector: .list(selectors), source: of.resourceId, type: .specificResource),
    motivation: of.motivation, anchor: "\(span.start):\(span.end):\(span.exact)",
    generator: of.generator, body: of.body)
}
public func annotationOfResource(_ of: OfResource) throws -> Annotation {
  try built(
    target: AnnotationTarget(source: of.resourceId), motivation: of.motivation, anchor: "",
    generator: of.generator, body: of.body)
}
