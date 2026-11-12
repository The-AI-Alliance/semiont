import Foundation
import Synchronization
import Testing

@testable import Semiont

@Test func listenersQueueFromCreationAndNeverStealOrDrop() async throws {
  let source = Broadcast<Int>()
  let first = source.listen()
  let second = source.listen()
  for n in 0..<10_000 { source.yield(n) }
  source.finish()
  var one: [Int] = []
  var two: [Int] = []
  for try await value in first { one.append(value) }
  for try await value in second { two.append(value) }
  #expect(one == Array(0..<10_000))
  #expect(two == one)
  var late = source.listen().makeAsyncIterator()
  #expect(try await late.next() == nil)
}
private final class Said: Sendable {}
@Test func endingLetsGoOfWhatWasKeptForAFirstListenerWhoNeverCame() async throws {
  let source = Broadcast<Said>(keepingForFirst: true)
  weak var probe: Said?
  do {
    let said = Said()
    probe = said
    source.yield(said)
  }
  let keptBeforeTheEnd = probe != nil
  #expect(keptBeforeTheEnd)
  source.finish()
  let keptAfterTheEnd = probe != nil
  #expect(!keptAfterTheEnd)
  var late = source.listen().makeAsyncIterator()
  let lateHearsOnlyTheEnd = try await late.next() == nil
  #expect(lateHearsOnlyTheEnd)
}
@Test func eventsRefuseASecondConsumerAndDisposeFinishes() async throws {
  let source = Broadcast<Int>()
  let events = source.listen()
  var first = events.makeAsyncIterator()
  var second = events.makeAsyncIterator()
  source.yield(1)
  #expect(try await first.next() == 1)
  source.finish()
  await #expect(throws: MultipleConsumers.self) { try await second.next() }
  events.dispose()
  events.dispose()
  #expect(try await first.next() == nil)
}
@Test func watchedEndsWithItsFinalValueForExistingAndFutureListeners() async {
  let watched = Watched(1)
  var first = watched.makeAsyncIterator()
  #expect(await first.next() == 1)
  watched.set(1)
  #expect(await first.next() == 1)
  watched.finish(with: 2)
  watched.set(3)
  #expect(watched.value == 2)
  #expect(await first.next() == 2)
  #expect(await first.next() == nil)
  var late = watched.makeAsyncIterator()
  #expect(await late.next() == 2)
  #expect(await late.next() == nil)
}
@Test func dedupEvictsOnlyOutsideTheConfiguredWindow() {
  var ids = SeenEventIDs(capacity: 3)
  var actual: [Bool] = []
  for id in ["e-a", "e-b", "p-c-3", "e-a", "e-d", "e-a"] { actual.append(ids.remember(id)) }
  #expect(actual == [true, true, true, false, true, true])
  var disabled = SeenEventIDs(capacity: 0)
  let first = disabled.remember("e-a")
  let second = disabled.remember("e-a")
  #expect(first && second)
}
@Test func theFirstListenerIsGivenTheLatestGivenBeforeAnyoneListenedInOrder() async throws {
  let source = Broadcast<Int>(keepingForFirst: true)
  let beyond = 5
  let given = Array(0..<(Timings.errorsKeptForFirstReaderCount + beyond))
  for n in given { source.yield(n) }
  let first = source.listen()
  source.finish()
  var heard: [Int] = []
  for try await value in first { heard.append(value) }
  #expect(heard == Array(given.dropFirst(beyond)))
}
/// What an action was called with, in order.
private final class Calls: Sendable {
  private let values = Mutex<[Int]>([])
  func called(_ value: Int) { values.withLock { $0.append(value) } }
  var all: [Int] { values.withLock { $0 } }
}
@Test func anActionGivenBeforeAnyoneListenedIsTheFirstListener() async throws {
  let source = Broadcast<Int>(keepingForFirst: true)
  let beyond = 5
  let given = Array(0..<(Timings.errorsKeptForFirstReaderCount + beyond))
  for n in given { source.yield(n) }
  let calls = Calls()
  source.onEach { calls.called($0) }
  let later = source.listen()
  source.yield(-1)
  source.finish()
  var heard: [Int] = []
  for try await value in later { heard.append(value) }
  #expect(calls.all == Array(given.dropFirst(beyond)) + [-1])
  #expect(heard == [-1])
}
