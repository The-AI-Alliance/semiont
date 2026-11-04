import Foundation

#if canImport(Darwin)
  import Darwin
#else
  import Glibc
#endif

private let httpWhitespace = CharacterSet(charactersIn: "\t\n\r ")
private let encodingWhitespace = CharacterSet(charactersIn: "\t\n\r\u{000C} ")
private let tokenPunctuation = CharacterSet(charactersIn: "!#$%&'*+-.^`_|~")
private let encodingByLabel = Dictionary(
  uniqueKeysWithValues: encodings.flatMap { row in
    row.labels.map { ($0, row) }
  })
private let singleByteScalars = Dictionary(
  uniqueKeysWithValues: encodings.compactMap { row in
    row.everyByte.map { (row.encoding, Array($0.unicodeScalars)) }
  })
private let systemEncodingNames = [
  "big5": "BIG5-HKSCS",
  "euc-jp": "EUC-JP",
  "euc-kr": "CP949",
  "gb18030": "GB18030",
  "gbk": "GB18030",
  "iso-2022-jp": "ISO-2022-JP",
  "shift_jis": "CP932",
]

/// Reads the text of a representation according to its media type, charset, and byte-order mark.
public func decodeRepresentation(_ bytes: Data, contentType: String) throws -> String {
  guard textSourceOf(contentType) == "decode" else {
    throw TransportError(
      .error, "The resource's media type \(baseMediaType(contentType)) does not supply decoded text"
    )
  }

  let label = charsetOf(contentType)?.trimmingCharacters(in: encodingWhitespace) ?? ""
  let encoding: String
  if label.isEmpty {
    encoding = "utf-8"
  } else {
    guard label.utf8.allSatisfy({ $0 < 128 }),
      let row = encodingByLabel[label.lowercased()], row.refused != true
    else {
      throw TransportError(.error, "Unsupported resource charset: \(label)")
    }
    encoding = row.encoding
  }

  if bytes.starts(with: [0xEF, 0xBB, 0xBF]) {
    return String(decoding: bytes.dropFirst(3), as: UTF8.self)
  }
  if bytes.starts(with: [0xFE, 0xFF]) {
    return decodeUTF16(bytes.dropFirst(2), littleEndian: false)
  }
  if bytes.starts(with: [0xFF, 0xFE]) {
    return decodeUTF16(bytes.dropFirst(2), littleEndian: true)
  }

  switch encoding {
  case "utf-8": return String(decoding: bytes, as: UTF8.self)
  case "utf-16le": return decodeUTF16(bytes, littleEndian: true)
  case "utf-16be": return decodeUTF16(bytes, littleEndian: false)
  default:
    if let scalars = singleByteScalars[encoding] {
      return String(String.UnicodeScalarView(bytes.map { scalars[Int($0)] }))
    }
    guard let systemName = systemEncodingNames[encoding] else {
      throw TransportError(.error, "Unsupported resource charset: \(label)")
    }
    return try decodeLegacy(bytes, systemName: systemName, label: label)
  }
}

private func decodeUTF16(_ bytes: Data, littleEndian: Bool) -> String {
  var units: [UInt16] = []
  units.reserveCapacity(bytes.count / 2)
  var iterator = bytes.makeIterator()
  while let first = iterator.next() {
    guard let second = iterator.next() else {
      // An unfinished surrogate and an odd final byte are one decoder error.
      if units.last.map({ (0xD800...0xDBFF).contains($0) }) != true {
        units.append(0xFFFD)
      }
      break
    }
    let high = littleEndian ? second : first
    let low = littleEndian ? first : second
    units.append(UInt16(high) << 8 | UInt16(low))
  }
  return String(decoding: units, as: UTF16.self)
}

private func decodeLegacy(_ bytes: Data, systemName: String, label: String) throws -> String {
  guard let converter = iconv_open("UTF-8", systemName),
    Int(bitPattern: converter) != -1
  else {
    throw TransportError(.error, "Unsupported resource charset: \(label)")
  }
  defer { iconv_close(converter) }

  var input = Array(bytes)
  var output = [UInt8](repeating: 0, count: 4096)
  var decoded = Data()
  try input.withUnsafeMutableBytes { rawInput in
    var cursor = rawInput.bindMemory(to: CChar.self).baseAddress
    var remaining = rawInput.count
    while remaining > 0 {
      var capacity = output.count
      let status = output.withUnsafeMutableBytes { rawOutput in
        var destination = rawOutput.bindMemory(to: CChar.self).baseAddress
        return iconv(converter, &cursor, &remaining, &destination, &capacity)
      }
      let failure = status == -1 ? errno : 0
      decoded.append(contentsOf: output.prefix(output.count - capacity))
      switch failure {
      case 0, E2BIG: continue
      case EILSEQ:
        decoded.append(contentsOf: "�".utf8)
        cursor = cursor?.advanced(by: 1)
        remaining -= 1
      case EINVAL:
        decoded.append(contentsOf: "�".utf8)
        return
      default:
        throw TransportError(.error, "Could not decode resource charset: \(label)")
      }
    }
  }
  return String(decoding: decoded, as: UTF8.self)
}

private func isToken(_ text: ArraySlice<Unicode.Scalar>) -> Bool {
  !text.isEmpty
    && text.allSatisfy { scalar in
      let value = scalar.value
      return (48...57).contains(value) || (65...90).contains(value) || (97...122).contains(value)
        || tokenPunctuation.contains(scalar)
    }
}

private func charsetOf(_ contentType: String) -> String? {
  let text = Array(contentType.trimmingCharacters(in: httpWhitespace).unicodeScalars)
  let end = text.firstIndex(of: ";") ?? text.endIndex
  guard let slash = text[..<end].firstIndex(of: "/"), isToken(text[..<slash]) else { return nil }
  var subtype = text[(slash + 1)..<end]
  while let last = subtype.last, httpWhitespace.contains(last) { subtype = subtype.dropLast() }
  guard isToken(subtype) else { return nil }

  var index = end
  while index < text.endIndex {
    index += 1
    while index < text.endIndex, httpWhitespace.contains(text[index]) { index += 1 }
    let start = index
    while index < text.endIndex, text[index] != "=", text[index] != ";" { index += 1 }
    let name = String(String.UnicodeScalarView(text[start..<index])).lowercased()
    guard index < text.endIndex, text[index] == "=" else { continue }
    index += 1
    guard index < text.endIndex else { break }

    var value = String.UnicodeScalarView()
    if text[index] == "\"" {
      index += 1
      while index < text.endIndex, text[index] != "\"" {
        if text[index] == "\\", index + 1 < text.endIndex { index += 1 }
        value.append(text[index])
        index += 1
      }
      while index < text.endIndex, text[index] != ";" { index += 1 }
    } else {
      let start = index
      while index < text.endIndex, text[index] != ";" { index += 1 }
      var unquoted = text[start..<index]
      while let last = unquoted.last, httpWhitespace.contains(last) {
        unquoted = unquoted.dropLast()
      }
      guard !unquoted.isEmpty else { continue }
      value.append(contentsOf: unquoted)
    }
    if name == "charset",
      value.allSatisfy({
        $0 == "\t" || (32...126).contains($0.value) || (128...255).contains($0.value)
      })
    {
      return String(value)
    }
  }
  return nil
}
