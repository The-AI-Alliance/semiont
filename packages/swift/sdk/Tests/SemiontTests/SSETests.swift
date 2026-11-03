import Foundation
import Testing

@testable import Semiont

@Test func sseSurvivesEveryByteBoundary() throws {
  let bytes = Array(
    "\u{feff}: ping\r\nevent: bus-event\r\nid: e-1\r\ndata: {\"word\":\"🦊\"}\r\ndata: second\r\n\r\n"
      .utf8)
  for cut in 0...bytes.count {
    var parser = SSEParser()
    let events = parser.feed(bytes[..<cut]) + parser.feed(bytes[cut...])
    #expect(events == [SSEEvent(event: "bus-event", id: "e-1", data: "{\"word\":\"🦊\"}\nsecond")])
  }
}

@Test func sseAcceptsBareCRAndIgnoresCommentsAndNulIds() throws {
  var parser = SSEParser()
  let events = parser.feed(
    Array("event: bus-event\rid: bad\0id\rdata: x\r\r: comment\n\ndata: y\n\n".utf8))
  #expect(
    events == [
      SSEEvent(event: "bus-event", id: nil, data: "x"),
      SSEEvent(event: "message", id: nil, data: "y"),
    ])
}

@Test func sseSeparatorsDoNotConsumeCombiningScalars() {
  var parser = SSEParser()
  let events = parser.feed(Array("data: \u{301}x\n\n".utf8))
  #expect(events.first?.data.utf8.elementsEqual("\u{301}x".utf8) == true)
}
