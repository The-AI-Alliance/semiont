import Testing

@testable import Semiont

private func entityTypesReply(_ types: [String]) throws -> [String: JSONValue] {
  try wirePayload(BrowseEntityTypesResult(response: GetEntityTypesResponse(entityTypes: types)))
}

@Test func cacheFailureRetriesOnceAndNewObserverRecoversTheOriginalObserver() async throws {
  let transport = ProbeTransport()
  transport.handle { _, _ in throw BusRequestError(.busClosed, "scripted failure") }
  let client = try await SemiontClient(transport: transport)
  defer { client.dispose() }

  try await within(5000) {
    let query = client.browse.entityTypes()
    #expect(query === client.browse.entityTypes())
    #expect(transport.calls.isEmpty)
    var original = query.makeAsyncIterator()
    let pending = try #require(await original.next())
    switch pending {
    case .pending: break
    case .ready, .failed: Issue.record("The first observation must be pending")
    }
    guard case .failed(let error)? = await original.next() else {
      Issue.record("An exhausted retry must emit a failed state")
      return
    }
    #expect((error as? BusRequestError)?.description == "scripted failure")
    #expect(transport.calls.count == 2)
    transport.handle { _, _ in try entityTypesReply(["Recovered"]) }
    var later = query.makeAsyncIterator()
    guard case .pending? = await later.next(), case .pending? = await original.next(),
      case .ready(let first)? = await original.next(),
      case .ready(let second)? = await later.next()
    else {
      Issue.record("Both observers must see the recovery")
      return
    }
    #expect(first == ["Recovered"])
    #expect(second == first)
    #expect(transport.calls.count == 3)
    client.dispose()
    #expect(await original.next() == nil)
    #expect(await later.next() == nil)
    do {
      _ = try await query.fresh()
      Issue.record("A closed query fetched a value")
    } catch let error as BusRequestError {
      #expect(error.reason == .busClosed)
    }
    #expect(transport.calls.count == 3)
  }
}

@Test func vocabularyEventRefreshesOnlyItsKnownQueryAndKeepsTheOldValueVisible() async throws {
  let transport = ProbeTransport()
  transport.handle { _, _ in try entityTypesReply(["Old"]) }
  let client = try await SemiontClient(transport: transport)
  defer { client.dispose() }

  try await within(5000) {
    let query = client.browse.entityTypes()
    let first = try await query.fresh()
    #expect(first == ["Old"])
    var observer = query.makeAsyncIterator()
    guard case .ready(let initial)? = await observer.next() else {
      Issue.record("The observer should reuse the fetched value")
      return
    }
    #expect(initial == ["Old"])
    #expect(transport.calls.count == 1)

    transport.handle { _, _ in try entityTypesReply(["New"]) }
    let channel = Channels.frameEntityTypeAdded.name
    let event = try StoredEventResponse(
      id: "e-frame", metadata: EventMetadata(sequenceNumber: 0), payload: [:],
      timestamp: "2026-11-03T00:00:00Z", type: channel,
      userId: UserId("did:web:kb.test:users:person"), version: 1)
    transport.deliver(ReceivedFrame(channel: channel, payload: try wirePayload(event)))
    guard case .ready(let updated)? = await observer.next() else {
      Issue.record("Invalidation should replace the ready value without emitting pending")
      return
    }
    #expect(updated == ["New"])
    transport.handle { _, _ in try entityTypesReply(["Reopened"]) }
    transport.state.set(.degraded)
    transport.state.set(.open)
    guard case .ready(let reopened)? = await observer.next() else {
      Issue.record("Reopening should refresh the known query")
      return
    }
    #expect(reopened == ["Reopened"])

    #expect(
      transport.calls.map(\.name)
        == Array(repeating: Channels.browseEntityTypesRequested.name, count: 3))
  }
}

@Test func invalidationDoesNotWaitForAnOrphanedFetch() async throws {
  let transport = ProbeTransport()
  let started = Watched(false)
  let release = Watched(false)
  transport.handle { _, _ in
    if transport.calls.count == 1 {
      started.set(true)
      for await released in release where released { break }
      try Task.checkCancellation()
      return try entityTypesReply(["Late"])
    }
    return try entityTypesReply(["Current"])
  }
  let client = try await SemiontClient(transport: transport)
  defer {
    release.set(true)
    client.dispose()
  }

  try await within(5000) {
    let query = client.browse.entityTypes()
    var first = query.makeAsyncIterator()
    var second = query.makeAsyncIterator()
    guard case .pending? = await first.next(), case .pending? = await second.next() else {
      Issue.record("Both observers should share the pending fetch")
      return
    }
    for await issued in started where issued { break }
    #expect(transport.calls.count == 1)
    await query.invalidate()
    guard case .ready(let current)? = await first.next() else {
      Issue.record("The invalidation did not start an independent fetch")
      return
    }
    #expect(current == ["Current"])
    release.set(true)
    guard case .ready(let late)? = await first.next() else {
      Issue.record("The earlier fetch should still publish its result")
      return
    }
    #expect(late == ["Late"])
    #expect(transport.calls.count == 2)
  }
}

@Test func scopedEventsRefreshOnlyTheirResourceAndScopesEndWithObservation() async throws {
  let transport = ProbeTransport()
  surfaceReplies(transport, cloneAnswer: nil)
  let client = try await SemiontClient(transport: transport)
  defer { client.dispose() }

  try await within(5000) {
    let first = try ResourceId("first")
    let second = try ResourceId("second")
    let firstQuery = client.browse.events(first)
    let secondQuery = client.browse.events(second)
    _ = client.browse.events(try ResourceId("cold"))
    #expect(client.browse.events(first) === firstQuery)
    #expect(transport.holds == 0)

    var firstReader = firstQuery.makeAsyncIterator()
    var secondReader = secondQuery.makeAsyncIterator()
    guard case .pending? = await firstReader.next(), case .ready? = await firstReader.next(),
      case .pending? = await secondReader.next(), case .ready? = await secondReader.next()
    else {
      Issue.record("Each scoped query should load independently")
      return
    }
    #expect(transport.holds == 2)
    for await state in firstQuery {
      guard case .ready = state else {
        Issue.record("The second reader should reuse the ready value")
        break
      }
      #expect(transport.holds == 3)
      break
    }
    #expect(transport.holds == 2)

    let gap = BusResumeGap(lastSeenId: "p-first-1", reason: .retentionExceeded, scope: first)
    transport.deliver(
      ReceivedFrame(channel: Channels.busResumeGap.name, payload: try wirePayload(gap)))
    guard case .ready? = await firstReader.next() else {
      Issue.record("A replay gap should refresh the affected query")
      return
    }
    let channel = Channels.markBodyUpdated.name
    let edit = try EnrichedResourceEvent(
      id: "e-edit", metadata: EventMetadata(sequenceNumber: 2), payload: [:], resourceId: second,
      timestamp: "2026-11-03T00:00:00Z", type: channel,
      userId: UserId("did:web:kb.test:users:person"), version: 1)
    transport.deliver(ReceivedFrame(channel: channel, payload: try wirePayload(edit)))
    guard case .ready? = await secondReader.next() else {
      Issue.record("An annotation edit should refresh the history of its resource")
      return
    }
    #expect(
      transport.calls.map { $0.payload["resourceId"] } == [
        .string(first.value), .string(second.value), .string(first.value), .string(second.value),
      ])
    client.dispose()
    #expect(await firstReader.next() == nil)
    #expect(await secondReader.next() == nil)
    #expect(transport.holds == 0)
  }
}
