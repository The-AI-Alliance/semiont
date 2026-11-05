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

  try await within(testDeadlineMs) {
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

  try await within(testDeadlineMs) {
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

  try await within(testDeadlineMs) {
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

  try await within(testDeadlineMs) {
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
      id: "e-edit", metadata: EventMetadata(sequenceNumber: 2),
      payload: wirePayload(
        AnnotationBodyUpdatedPayload(annotationId: AnnotationId("edited"), operations: [])),
      resourceId: second,
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

@Test func annotationEditsWriteThroughOrRefetchTheNamedCaches() async throws {
  let transport = ProbeTransport()
  let resource = try ResourceId("document")
  let id = try AnnotationId("annotated")
  let original = Annotation(
    created: "2026-11-04T00:00:00Z", id: id, motivation: .commenting,
    target: .resourceId(resource))
  let enriched = Annotation(
    created: original.created, id: id, modified: "2026-11-04T00:01:00Z",
    motivation: original.motivation, target: original.target)
  let fetched = Annotation(
    created: original.created, id: id, modified: "2026-11-04T00:02:00Z",
    motivation: original.motivation, target: original.target)
  transport.setAnnotations([original])
  transport.handle { _, _ in try annotationReply(original) }
  let client = try await SemiontClient(transport: transport)
  defer { client.dispose() }

  try await within(testDeadlineMs) {
    let list = client.browse.annotations(resource)
    let detail = client.browse.annotation(resourceId: resource, annotationId: id)
    #expect(detail === client.browse.annotation(resourceId: resource, annotationId: id))
    _ = client.browse.annotation(resourceId: resource, annotationId: try AnnotationId("cold"))
    _ = try await list.fresh()
    _ = try await detail.fresh()
    var listReader = list.makeAsyncIterator()
    var detailReader = detail.makeAsyncIterator()
    guard case .ready? = await listReader.next(), case .ready? = await detailReader.next() else {
      Issue.record("Both queries should have a cached annotation")
      return
    }
    let channel = Channels.markBodyUpdated.name
    let payload = try wirePayload(AnnotationBodyUpdatedPayload(annotationId: id, operations: []))
    var event = try EnrichedResourceEvent(
      annotation: enriched, id: "e-write", metadata: EventMetadata(sequenceNumber: 1),
      payload: payload, resourceId: resource, timestamp: "2026-11-04T00:01:00Z",
      type: channel, userId: UserId("did:web:kb.test:users:person"), version: 1)
    transport.deliver(ReceivedFrame(channel: channel, payload: try wirePayload(event)))
    guard case .ready(let writtenList)? = await listReader.next(),
      case .ready(let writtenDetail)? = await detailReader.next()
    else {
      Issue.record("An enriched edit should publish both values directly")
      return
    }
    #expect(writtenList.map(\.modified) == [enriched.modified])
    #expect(writtenDetail.modified == enriched.modified)
    #expect(transport.calls.count == 2)

    transport.setAnnotations([fetched])
    transport.handle { _, _ in try annotationReply(fetched) }
    event.annotation = nil
    event.id = "e-refetch"
    transport.deliver(ReceivedFrame(channel: channel, payload: try wirePayload(event)))
    guard case .ready(let fetchedList)? = await listReader.next(),
      case .ready(let fetchedDetail)? = await detailReader.next()
    else {
      Issue.record("An unenriched edit should refetch without discarding the old value")
      return
    }
    #expect(fetchedList.map(\.modified) == [fetched.modified])
    #expect(fetchedDetail.modified == fetched.modified)
    #expect(transport.calls.count == 4)
  }
}

@Test(arguments: [false, true])
func annotationRemovalSurvivesAnEarlierInFlightRead(confirmedByReply: Bool) async throws {
  let transport = ProbeTransport()
  let started = Watched(false)
  let release = Watched(false)
  let resource = try ResourceId("document")
  let id = try AnnotationId("removed")
  let original = Annotation(
    created: "2026-11-04T00:00:00Z", id: id, motivation: .commenting,
    target: .resourceId(resource))
  transport.handle { _, _ in try annotationReply(original) }
  let client = try await SemiontClient(transport: transport)
  defer {
    release.set(true)
    client.dispose()
  }

  try await within(testDeadlineMs) {
    let detail = client.browse.annotation(resourceId: resource, annotationId: id)
    var reader = detail.makeAsyncIterator()
    guard case .pending? = await reader.next(), case .ready? = await reader.next() else {
      Issue.record("The detail should be ready before removal")
      return
    }
    transport.handle { _, _ in
      started.set(true)
      for await ready in release where ready { break }
      return try annotationReply(original)
    }
    let stale = Task { try await detail.fresh() }
    defer { stale.cancel() }
    for await issued in started where issued { break }
    if confirmedByReply {
      let reply = MarkDeleteOk(response: MarkDeleteOkResponse(annotationId: id))
      transport.deliver(
        ReceivedFrame(channel: Channels.markDeleteOk.name, payload: try wirePayload(reply)))
    } else {
      let channel = Channels.markRemoved.name
      let event = try StoredEventResponse(
        id: "e-remove", metadata: EventMetadata(sequenceNumber: 2),
        payload: wirePayload(AnnotationRemovedPayload(annotationId: id)), resourceId: resource,
        timestamp: "2026-11-04T00:01:00Z", type: channel,
        userId: UserId("did:web:kb.test:users:person"), version: 1)
      transport.deliver(ReceivedFrame(channel: channel, payload: try wirePayload(event)))
    }
    guard case .failed(let removed)? = await reader.next() else {
      Issue.record("Removal should fail the detail directly")
      return
    }
    #expect((removed as? BusRequestError)?.reason == .busNotFound)
    release.set(true)
    _ = try await stale.value
    #expect(transport.calls.count == 2)

    transport.handle { _, _ in throw BusRequestError(.busNotFound, "Missing from service") }
    var later = detail.makeAsyncIterator()
    guard case .pending? = await later.next(), case .pending? = await reader.next(),
      case .failed(let answer)? = await later.next()
    else {
      Issue.record("The older result should not resurrect the detail before recovery")
      return
    }
    #expect((answer as? BusRequestError)?.description == "Missing from service")
  }
}

@Test func anEditDuringAListReadKeepsOtherItemsFromTheResponse() async throws {
  let lifetime = Lifetime()
  let started = Watched(false)
  let release = Watched(false)
  let query = Cached(lifetime: lifetime) {
    started.set(true)
    for await ready in release where ready { break }
    return ["old", "added"]
  }
  defer {
    release.set(true)
    lifetime.end()
  }

  try await within(testDeadlineMs) {
    var reader = query.makeAsyncIterator()
    guard case .pending? = await reader.next() else {
      Issue.record("The list should still be loading")
      return
    }
    for await issued in started where issued { break }
    await query.editIfKnown { ["edited"] + $0.dropFirst() }
    release.set(true)
    guard case .ready(let result)? = await reader.next() else {
      Issue.record("The read and edit should publish a merged list")
      return
    }
    #expect(result == ["edited", "added"])
  }
}

@Test func enginesKeepTheirOrderAndOnlyJoinLimitsForTheSameProviderAndModel() async throws {
  let transport = ProbeTransport()
  let first = Engine(model: "shared-name", provider: .openai)
  let second = Engine(model: "shared-name", provider: .ollama)
  let answering = try #require(Operations.limits.first).request.name
  transport.handle { operation, _ in
    if operation == Operations.browseEnginesRequested.request.name {
      return try wirePayload(
        BrowseEnginesResult(
          response: BrowseEnginesResultResponse(
            engines: [EngineEntry(engine: first), EngineEntry(engine: second)])))
    }
    if operation == answering {
      return try wirePayload(
        InferenceLimitsResult(
          response: InferenceLimitsResultResponse(
            limits: [
              EngineLimits(
                engine: second, limits: InferenceLimits(contextTokens: 8192, maxOutputTokens: 512))
            ])))
    }
    throw BusRequestError(.busPeerUnavailable, "No credentials here")
  }
  let client = try await SemiontClient(transport: transport)
  defer { client.dispose() }

  let engines = try await client.browse.engines().fresh()
  #expect(engines.map { $0.engine.provider } == [.openai, .ollama])
  #expect(engines.map { $0.limits?.contextTokens } == [nil, 8192])
}
