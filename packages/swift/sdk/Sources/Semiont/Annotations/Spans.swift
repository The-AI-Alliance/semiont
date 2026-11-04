import Foundation

public struct QuotedText: Codable, Sendable {
  public let exact: String
  public let prefix: String?
  public let suffix: String?
  public init(exact: String, prefix: String? = nil, suffix: String? = nil) {
    self.exact = exact
    self.prefix = prefix
    self.suffix = suffix
  }
}
public struct TextSpan: Codable, Sendable {
  public let start: Int
  public let end: Int
  public let exact: String
  public let prefix: String?
  public let suffix: String?
  public init(start: Int, end: Int, exact: String, prefix: String? = nil, suffix: String? = nil) {
    self.start = start
    self.end = end
    self.exact = exact
    self.prefix = prefix
    self.suffix = suffix
  }
  private enum CodingKeys: String, CodingKey { case start, end, exact, prefix, suffix }
  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    do {
      start = try c.decode(Int.self, forKey: .start)
      end = try c.decode(Int.self, forKey: .end)
    } catch {
      throw SpanRefusedError(reason: .spanOutOfRange, message: "Span offsets must be whole numbers")
    }
    exact = try c.decode(String.self, forKey: .exact)
    prefix = try c.decodeIfPresent(String.self, forKey: .prefix)
    suffix = try c.decodeIfPresent(String.self, forKey: .suffix)
  }

}
public enum MatchQuality: String, Codable, Sendable, CaseIterable {
  case normalized
  case caseInsensitive = "case-insensitive"
  case fuzzy
}
public enum AnchorMethod: String, Codable, Sendable, CaseIterable {
  case uniqueMatch = "unique-match"
  case contextRecovered = "context-recovered"
  case firstOfMany = "first-of-many"
  case fuzzyMatch = "fuzzy-match"
}
public struct ReconciledSpan: Encodable, Sendable {
  public let span: TextSpan
  public let anchorMethod: AnchorMethod
  public let matchQuality: MatchQuality?
  public func encode(to encoder: any Encoder) throws {
    try span.encode(to: encoder)
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(anchorMethod, forKey: .anchorMethod)
    try c.encodeIfPresent(matchQuality, forKey: .matchQuality)
  }
  private enum CodingKeys: String, CodingKey { case anchorMethod, matchQuality }
}

struct ScalarText {
  let points: [Unicode.Scalar]
  init(_ text: String) { points = Array(text.unicodeScalars) }
  init(_ points: [Unicode.Scalar]) { self.points = points }
  var count: Int { points.count }
  func text(_ start: Int = 0, _ end: Int? = nil) -> String {
    String(String.UnicodeScalarView(points[start..<(end ?? count)]))
  }
  func places(_ words: ScalarText) -> [Int] {
    guard words.count > 0, words.count <= count else { return [] }
    return (0...(count - words.count)).filter {
      points[$0..<($0 + words.count)].elementsEqual(words.points)
    }
  }
  func contains(_ words: String) -> Bool { !places(ScalarText(words)).isEmpty }
}
func trimmed(_ text: String) -> String {
  let points = Array(text.unicodeScalars)
  let first = points.firstIndex { !$0.properties.isWhitespace } ?? points.endIndex
  let last = points.lastIndex { !$0.properties.isWhitespace }.map { $0 + 1 } ?? first
  return ScalarText(Array(points[first..<last])).text()
}
func collapsed(_ text: String) -> String {
  var output = String.UnicodeScalarView()
  var whitespace = false
  for point in trimmed(text).unicodeScalars {
    if point.properties.isWhitespace {
      if !whitespace { output.append(" ") }
      whitespace = true
    } else {
      output.append(point)
      whitespace = false
    }
  }
  return String(output)
}
private struct Changed {
  var points: [Unicode.Scalar] = []
  var cameFrom: [Int] = []
  mutating func append(_ text: String, from: Int) {
    for point in text.unicodeScalars {
      points.append(point)
      cameFrom.append(from)
    }
  }
  func places(_ wanted: ScalarText) -> [Range<Int>] {
    ScalarText(points).places(wanted).map { cameFrom[$0]..<(cameFrom[$0 + wanted.count - 1] + 1) }
  }
}
private func normalized(_ text: ScalarText) -> Changed {
  var result = Changed()
  var run: Int?
  for (offset, point) in text.points.enumerated() {
    if point.properties.isWhitespace {
      if run == nil { run = offset }
      continue
    }
    if let began = run {
      if !result.points.isEmpty { result.append(" ", from: began) }
      run = nil
    }
    let plain: String
    switch point.value {
    case 0x2018, 0x2019: plain = "'"
    case 0x201c, 0x201d: plain = "\""
    case 0x2014: plain = "--"
    case 0x2013: plain = "-"
    default: plain = String(point)
    }
    result.append(plain, from: offset)
  }
  return result
}
private func lowerCased(_ text: ScalarText) -> Changed {
  var result = Changed()
  for (offset, point) in text.points.enumerated() {
    result.append(String(point).lowercased(), from: offset)
  }
  // Whole-string casing includes contextual final sigma; scalar casing supplies provenance.
  result.points = Array(text.text().lowercased(with: Locale(identifier: "und")).unicodeScalars)
  precondition(result.points.count == result.cameFrom.count)
  return result
}
private func nearestStretch(_ text: ScalarText, _ exact: ScalarText) -> Range<Int>? {
  let size = exact.count
  let allowance = size / 20
  guard allowance > 0, text.count >= size - allowance else { return nil }
  let lengths = [size] + (1...allowance).flatMap { [size - $0, size + $0] }
  var best: (distance: Int, range: Range<Int>)?
  for start in 0...(text.count - (size - allowance)) {
    let longest = min(size + allowance, text.count - start)
    let beyond = allowance + 1
    let width = 2 * allowance + 3
    var row = Array(repeating: beyond, count: width)
    for length in 0...min(allowance, longest) { row[length + allowance + 1] = length }
    var refused = false
    for taken in 1...size {
      let above = row
      row = Array(repeating: beyond, count: width)
      var least = beyond
      let low = max(0, taken - allowance)
      let high = min(longest, taken + allowance)
      if low <= high {
        for length in low...high {
          let at = length - taken + allowance + 1
          let distance: Int
          if length == 0 {
            distance = taken
          } else {
            let replaced = exact.points[taken - 1] == text.points[start + length - 1] ? 0 : 1
            distance = min(above[at + 1] + 1, row[at - 1] + 1, above[at] + replaced, beyond)
          }
          row[at] = distance
          least = min(least, distance)
        }
      }
      if least > allowance {
        refused = true
        break
      }
    }
    if refused { continue }
    for length in lengths where length <= longest {
      let distance = row[length - size + allowance + 1]
      if distance <= allowance, best == nil || distance < (best?.distance ?? beyond) {
        best = (distance, start..<(start + length))
      }
    }
  }
  return best?.range
}
private func hinted(_ text: ScalarText, _ places: [Range<Int>], _ quoted: QuotedText) -> Range<Int>?
{
  let prefix = quoted.prefix.flatMap { trimmed($0).isEmpty ? nil : $0 }
  let suffix = quoted.suffix.flatMap { trimmed($0).isEmpty ? nil : $0 }
  guard prefix != nil || suffix != nil else { return nil }
  return places.first { place in
    if let prefix,
      !ScalarText(
        text.text(max(0, place.lowerBound - max(32, prefix.unicodeScalars.count)), place.lowerBound)
      )
      .contains(trimmed(prefix))
    {
      return false
    }
    if let suffix,
      !ScalarText(
        text.text(
          place.upperBound, min(text.count, place.upperBound + max(32, suffix.unicodeScalars.count))
        )
      )
      .contains(trimmed(suffix))
    {
      return false
    }
    return true
  }
}
private func reconciled(
  _ text: ScalarText, _ at: Range<Int>, _ method: AnchorMethod, _ quality: MatchQuality? = nil
) -> ReconciledSpan {
  let boundary = Set(".,;:!?'\"()[]{}<>/\\".unicodeScalars)
  func isBoundary(_ point: Unicode.Scalar) -> Bool {
    point.properties.isWhitespace || boundary.contains(point)
  }
  var begins = max(0, at.lowerBound - 64)
  let first = max(0, begins - 32)
  while begins > first, !isBoundary(text.points[begins - 1]) { begins -= 1 }
  var ends = min(text.count, at.upperBound + 64)
  let last = min(text.count, ends + 32)
  while ends < last, !isBoundary(text.points[ends]) { ends += 1 }
  return ReconciledSpan(
    span: TextSpan(
      start: at.lowerBound, end: at.upperBound, exact: text.text(at.lowerBound, at.upperBound),
      prefix: at.lowerBound == 0 ? nil : text.text(begins, at.lowerBound),
      suffix: at.upperBound == text.count ? nil : text.text(at.upperBound, ends)),
    anchorMethod: method, matchQuality: quality)
}
public func reconcile(text: String, quoted: QuotedText) -> ReconciledSpan? {
  guard !trimmed(quoted.exact).isEmpty else { return nil }
  let whole = ScalarText(text)
  let exact = ScalarText(quoted.exact)
  let found = whole.places(exact).map { $0..<($0 + exact.count) }
  if found.count == 1, let first = found.first { return reconciled(whole, first, .uniqueMatch) }
  if let first = found.first {
    if let chosen = hinted(whole, found, quoted) {
      return reconciled(whole, chosen, .contextRecovered)
    }
    return reconciled(whole, first, .firstOfMany)
  }
  let searches: [(Changed, ScalarText, MatchQuality)] = [
    (normalized(whole), ScalarText(normalized(exact).points), .normalized),
    (
      lowerCased(whole), ScalarText(quoted.exact.lowercased(with: Locale(identifier: "und"))),
      .caseInsensitive
    ),
  ]
  for (changed, wanted, quality) in searches {
    let places = changed.places(wanted)
    if let first = places.first {
      return reconciled(whole, hinted(whole, places, quoted) ?? first, .fuzzyMatch, quality)
    }
  }
  if let nearest = nearestStretch(whole, exact) {
    return reconciled(whole, nearest, .fuzzyMatch, .fuzzy)
  }
  return nil
}
