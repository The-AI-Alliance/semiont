import Semiont
import Testing

@Test func aTransportCanSupplyReadOnlyStateFromItsOwnStream() async throws {
  let (updates, continuation) = AsyncStream<ConnectionState>.makeStream()
  let watched = Watched(ConnectionState.initial, updates: updates)
  var reader = watched.makeAsyncIterator()
  #expect(await reader.next() == .initial)
  continuation.yield(.open)
  #expect(await reader.next() == .open)
  continuation.finish()
  #expect(await reader.next() == nil)
  #expect(watched.value == .open)
}
@Test func aTransportCanSupplyLosslessEventsAndAResourceHold() async throws {
  let (updates, continuation) = AsyncThrowingStream<Int, any Error>.makeStream()
  let events = Events(updates, stop: { continuation.finish() })
  let hold = ResourceHold { continuation.finish() }
  continuation.yield(1)
  continuation.yield(2)
  hold.dispose()
  var reader = events.makeAsyncIterator()
  #expect(try await reader.next() == 1)
  #expect(try await reader.next() == 2)
  #expect(try await reader.next() == nil)
}
