import Foundation
import Testing

@testable import Semiont

@Test func mediaTypesRunEverySharedCase() throws {
  let table = try Spec.read("media-types/cases.json").object
  for value in try required(table, "cloneFormat").array {
    let row = try value.object
    #expect(
      try cloneFormat(row["source"] == .null ? nil : row["source"].map { try $0.text })
        == required(row, "format").text)
  }
  for value in try required(table, "storageFileName").array {
    let row = try value.object
    #expect(
      try storageFileName(required(row, "name").text, format: required(row, "format").text)
        == required(row, "fileName").text)
  }
  for value in try required(table, "textSource").array {
    let row = try value.object
    let format = try required(row, "format").text
    #expect(.string(textSourceOf(format)) == (try required(row, "textSource")))
    #expect(.bool(yieldsGeometryOf(format)) == (try required(row, "yieldsGeometry")))
    #expect(.bool(derivesTextOf(format)) == (try required(row, "derivesText")))
  }
  #expect(Set(mediaTypes.map(\.textSource)) == Set(["decode", "pdf-text-layer", "none"]))
  #expect(Set(mediaTypes.map(\.mediaType)) == Set(SupportedMediaType.allCases.map(\.rawValue)))
  for (suffix, type) in extensionAliases {
    #expect(mediaTypeForExtension(suffix) == type)
    #expect(mediaTypeForExtension(String(suffix.dropFirst()).uppercased()) == type)
  }
  #expect(mediaTypeForExtension("unknown-semiont-format") == nil)
  for row in mediaTypes {
    #expect(isSupportedMediaType(row.mediaType))
    #expect(extensionForMediaType(row.mediaType) == row.extension)
  }
}
