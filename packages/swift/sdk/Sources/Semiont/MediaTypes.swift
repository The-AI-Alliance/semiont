import Foundation

public func baseMediaType(_ format: String) -> String {
  String(format.prefix { $0 != ";" }).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
}
public func isSupportedMediaType(_ format: String) -> Bool {
  mediaTypes.contains { $0.mediaType == format }
}
public func cloneFormat(_ source: String?) -> String {
  let base = baseMediaType(source ?? "text/plain")
  return mediaTypes.contains { $0.mediaType == base && $0.authorable } ? base : "text/plain"
}
public func extensionForMediaType(_ format: String) -> String {
  mediaTypes.first { $0.mediaType == baseMediaType(format) }?.extension ?? ".dat"
}
public func mediaTypeForExtension(_ ext: String) -> String? {
  let lower = ext.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
  let dotted = lower.hasPrefix(".") ? lower : "." + lower
  // The generated aliases are keyed by extension with its leading dot.
  if let alias = extensionAliases[dotted] { return alias }
  return mediaTypes.first { $0.extension == dotted }?.mediaType
}
public func storageFileName(_ name: String, format: String) -> String {
  var slug = ""
  var separated = true
  for point in name.lowercased().unicodeScalars {
    if (97...122).contains(point.value) || (48...57).contains(point.value) {
      slug.unicodeScalars.append(point)
      separated = false
    } else if !separated {
      slug += "-"
      separated = true
    }
  }
  if slug.hasSuffix("-") { slug.removeLast() }
  return slug + extensionForMediaType(format)
}
public func storageURI(_ name: String, format: String) -> String {
  "file://" + storageFileName(name, format: format)
}
public func textSourceOf(_ format: String) -> String {
  let base = baseMediaType(format)
  return mediaTypes.first { $0.mediaType == base }?.textSource
    ?? (base.hasPrefix("text/") ? "decode" : "none")
}
public func yieldsGeometryOf(_ format: String) -> Bool {
  let source = textSourceOf(format)
  switch source {
  case "decode", "none": return false
  case "pdf-text-layer": return true
  default: preconditionFailure("Unanswered media text source: \(source)")
  }
}
public func derivesTextOf(_ format: String) -> Bool {
  let source = textSourceOf(format)
  switch source {
  case "decode", "none": return false
  case "pdf-text-layer": return true
  default: preconditionFailure("Unanswered media text source: \(source)")
  }
}
