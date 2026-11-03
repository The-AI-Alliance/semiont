import Foundation

struct SSEEvent: Equatable, Sendable {
  let event: String
  let id: String?
  let data: String
}

struct SSEParser {
  private var line: [UInt8] = []
  private var event = "message"
  private var id: String?
  private var data: [String] = []
  private var firstLine = true
  private var afterCR = false

  mutating func feed<Bytes: Collection>(_ bytes: Bytes) -> [SSEEvent] where Bytes.Element == UInt8 {
    var result: [SSEEvent] = []
    for byte in bytes {
      if afterCR {
        afterCR = false
        if byte == 10 { continue }
      }
      if byte == 10 || byte == 13 {
        if let event = takeLine() { result.append(event) }
        afterCR = byte == 13
      } else {
        line.append(byte)
      }
    }
    return result
  }
  private mutating func takeLine() -> SSEEvent? {
    var bytes = line
    line.removeAll(keepingCapacity: true)
    if firstLine {
      firstLine = false
      if bytes.starts(with: [239, 187, 191]) { bytes.removeFirst(3) }
    }
    if bytes.isEmpty {
      let result =
        data.isEmpty
        ? nil
        : SSEEvent(
          event: event.isEmpty ? "message" : event, id: id, data: data.joined(separator: "\n"))
      event = "message"
      id = nil
      data.removeAll(keepingCapacity: true)
      return result
    }
    if bytes.first == 58 { return nil }
    let separator = bytes.firstIndex(of: 58)
    let field = String(decoding: bytes[..<(separator ?? bytes.endIndex)], as: UTF8.self)
    var body = separator.map { bytes[bytes.index(after: $0)...] } ?? bytes[bytes.endIndex...]
    if body.first == 32 { body = body.dropFirst() }
    let value = String(decoding: body, as: UTF8.self)
    switch field {
    case "event": event = value
    case "id": if !value.contains("\0") { id = value }
    case "data": data.append(value)
    default: break
    }
    return nil
  }
}

struct SeenEventIDs {
  private let capacity: Int
  private var ids: Set<String> = []
  private var ring: [String] = []
  private var next = 0
  init(capacity: Int) { self.capacity = capacity }
  mutating func remember(_ id: String) -> Bool {
    guard !ids.contains(id) else { return false }
    guard capacity > 0 else { return true }
    if ring.count == capacity {
      ids.remove(ring[next])
      ring[next] = id
      next = (next + 1) % capacity
    } else {
      ring.append(id)
    }
    ids.insert(id)
    return true
  }
}
