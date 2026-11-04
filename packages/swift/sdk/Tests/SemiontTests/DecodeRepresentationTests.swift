import Foundation
import Testing

@testable import Semiont

private func dataFromHex(_ hex: String) throws -> Data {
  try Data(hex.split(separator: " ").map { try #require(UInt8($0, radix: 16)) })
}

private func checkDecode(
  _ bytes: Data, contentType: String, expected: String?, refused: String?
) throws {
  do {
    let actual = try decodeRepresentation(bytes, contentType: contentType)
    #expect(refused == nil, "\(contentType)")
    #expect(
      actual.unicodeScalars.map(\.value) == expected?.unicodeScalars.map(\.value), "\(contentType)")
  } catch let error as TransportError {
    let name = try #require(refused, "\(contentType): \(error)")
    #expect(error.reason == .error)
    #expect(name.isEmpty || error.description.contains(name), "\(error)")
  }
}

@Test func decodesResourceBytesByTheSharedContentTypeAndBOMCases() throws {
  let table = try Spec.read("text/decode-cases.json").object
  for raw in try required(table, "cases").array {
    let row = try raw.object
    try checkDecode(
      dataFromHex(required(row, "bytes").text),
      contentType: required(row, "contentType").text,
      expected: row["text"]?.text, refused: row["refused"]?.text)
  }
}

@Test func decodesEverySharedEncodingLabelAndSingleByteMapping() throws {
  let table = try Spec.read("text/encoding-cases.json").object
  for raw in try required(table, "cases").array {
    let row = try raw.object
    let refuses = row["refused"] == .bool(true)
    let everyByte = try row["everyByte"]?.text
    let expected = try everyByte ?? row["text"]?.text
    let bytes: Data
    if everyByte != nil {
      bytes = Data(UInt8.min...UInt8.max)
    } else if refuses {
      bytes = Data([0xEF, 0xBB, 0xBF, 0x61])
    } else {
      bytes = try dataFromHex(required(row, "bytes").text)
    }
    for value in try required(row, "labels").array {
      let label = try value.text
      try checkDecode(
        bytes, contentType: "text/plain; charset=\" \(label.uppercased())\t\"",
        expected: expected, refused: refuses ? label.uppercased() : nil)
    }
  }
}

@Test func legacyDecodingContinuesAcrossOutputBuffersAndInvalidInput() throws {
  let bytes = Data(
    Array(repeating: [UInt8(0x93), 0xFA], count: 1_400).flatMap { $0 } + [
      0x82, 0x20, 0x82,
    ])
  let text = try decodeRepresentation(bytes, contentType: "text/plain; charset=shift_jis")
  #expect(text == String(repeating: "日", count: 1_400) + "� �")
}
