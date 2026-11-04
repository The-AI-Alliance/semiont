import Foundation
import Synchronization
import Testing

@testable import Semiont

@Test func localSignalsStayLocalAndFinishWithTheClientBus() async throws {
  let bus = EventBus()
  let events = bus.frames(Channels.beckonHover)
  try bus.emit(Channels.beckonHover, BeckonHoverEvent(annotationId: nil))
  var iterator = events.makeAsyncIterator()
  guard case .delivered(let first) = try await iterator.next() else {
    Issue.record("A local signal was not delivered")
    return
  }
  #expect(first.payload.annotationId == nil)
  bus.dispose()
  #expect(try await iterator.next() == nil)
}

struct Call: Equatable, Sendable {
  let via: String
  let name: String
  let payload: [String: JSONValue]
}
final class ProbeTransport: Transport, GatewayOperations, Sendable {
  let baseUrl = "http://kb.test"
  let emitted = Watched(false)
  let state = Watched<ConnectionState>(.open)
  private let hub = Broadcast<ReceivedFrame>()
  private let failureEvents = Broadcast<TransportError>()
  private struct State: Sendable {
    var calls: [Call] = []
    var count: Int? = 7
    var onFrames: (@Sendable () -> Void)?
    var frameEnds = 0
    var handler: (@Sendable (String, [String: JSONValue]) async throws -> [String: JSONValue])?
    var failure: BusRequestError?
    var holds = 0
    var disposals = 0
  }
  private let storage = Mutex(State())
  var calls: [Call] { storage.withLock { $0.calls } }
  var holds: Int { storage.withLock { $0.holds } }
  var disposals: Int { storage.withLock { $0.disposals } }
  func handle(
    _ handler: @escaping @Sendable (String, [String: JSONValue]) async throws -> [String: JSONValue]
  ) { storage.withLock { $0.handler = handler } }
  var frameEnds: Int { storage.withLock { $0.frameEnds } }
  func onFrames(_ action: @escaping @Sendable () -> Void) {
    storage.withLock { $0.onFrames = action }
  }
  func reset() { storage.withLock { $0.calls = [] } }
  func setCount(_ count: Int?) { storage.withLock { $0.count = count } }
  func setFailure(_ failure: BusRequestError?) { storage.withLock { $0.failure = failure } }
  func deliver(_ frame: ReceivedFrame) { hub.yield(frame) }
  func frames(_ channels: [String]) async throws -> Events<ReceivedFrame> {
    let source = hub.listen { [weak self] in self?.storage.withLock { $0.frameEnds += 1 } }
    storage.withLock { $0.onFrames }?()
    return source
  }
  func failures() -> Events<TransportError> { failureEvents.listen() }
  func subscribeToResource(_ resource: ResourceId) async -> ResourceHold {
    storage.withLock { $0.holds += 1 }
    return ResourceHold { [self] in storage.withLock { $0.holds -= 1 } }
  }
  func emit(
    channel: String, payload: [String: JSONValue], scope: ResourceId?, correlationId: String?
  ) async throws -> Int? {
    let count = storage.withLock {
      $0.calls.append(Call(via: "emit", name: channel, payload: payload))
      return $0.count
    }
    emitted.set(true)
    return count
  }
  func request(operation: String, payload: [String: JSONValue], timeoutMs: Int?) async throws
    -> [String: JSONValue]
  {
    let handler = try storage.withLock { state in
      state.calls.append(Call(via: "request", name: operation, payload: payload))
      if let failure = state.failure { throw failure }
      return state.handler
    }
    guard let handler else { throw SpecFailure.shape("Unscripted request: \(operation)") }
    return try await handler(operation, payload)
  }
  func dispose() {
    storage.withLock { $0.disposals += 1 }
    hub.finish()
    failureEvents.finish()
    state.finish(with: .closed)
  }
  func getCurrentUser() async throws -> UserResponse {
    storage.withLock { $0.calls.append(Call(via: "gateway", name: "getCurrentUser", payload: [:])) }
    return UserResponse(
      did: try UserId("did:web:kb.test:users:person"), domain: "kb.test", email: nil, image: nil,
      name: nil)
  }
  func getMediaToken(_ resource: ResourceId) async throws -> MediaTokenResponse {
    storage.withLock {
      $0.calls.append(
        Call(
          via: "gateway", name: "getMediaToken", payload: ["resourceId": .string(resource.value)]))
    }
    return MediaTokenResponse(token: "media-token")
  }
  func getProtectedResourceMetadata() async throws -> ProtectedResourceMetadata {
    storage.withLock {
      $0.calls.append(Call(via: "gateway", name: "getProtectedResourceMetadata", payload: [:]))
    }
    return ProtectedResourceMetadata(
      authorization_servers: ["https://issuer.test"], bearer_methods_supported: [.header],
      resource: "http://kb.test")
  }
  func healthCheck() async throws -> HealthResponse {
    storage.withLock { $0.calls.append(Call(via: "gateway", name: "healthCheck", payload: [:])) }
    return HealthResponse(
      message: "healthy", status: "ok", timestamp: "2026-11-03T00:00:00Z", version: "test")
  }
  func getStatus() async throws -> StatusResponse {
    storage.withLock { $0.calls.append(Call(via: "gateway", name: "getStatus", payload: [:])) }
    return StatusResponse(
      features: StatusResponseFeatures(collaboration: "yes", semanticContent: "yes"),
      message: "ready", status: "ok", version: "test")
  }
}
extension ProbeTransport: ContentTransport {
  private func recordContent(_ name: String, resource: ResourceId) {
    storage.withLock {
      $0.calls.append(
        Call(via: "content", name: name, payload: ["resourceId": .string(resource.value)]))
    }
  }
  func getBinary(_ resource: ResourceId) async throws -> Content {
    recordContent("getBinary", resource: resource)
    return Content(contentType: "text/plain; charset=windows-1252", bytes: Data([0, 255]))
  }
  func getBinaryStream(_ resource: ResourceId) async throws -> ContentStream {
    recordContent("getBinaryStream", resource: resource)
    let (stream, continuation) = AsyncThrowingStream<Data, any Error>.makeStream()
    continuation.yield(Data([0, 255]))
    continuation.finish()
    return ContentStream(contentType: "application/octet-stream", bytes: Events(stream, stop: {}))
  }
  func getResourceGraph(_ resource: ResourceId) async throws -> GetResourceResponse {
    recordContent("getResourceGraph", resource: resource)
    guard case .resource(let focus) = try contextFixture().focus else {
      throw SpecFailure.shape("resource focus")
    }
    return GetResourceResponse(annotations: [], resource: focus.resource)
  }
  func getAnchoredText(_ resource: ResourceId) async throws -> AnchoredTextAnswer {
    recordContent("getAnchoredText", resource: resource)
    return .anchoredTextAbsent(AnchoredTextAbsent(kind: .notYet))
  }
  func putBinary(_ request: PutBinaryRequest) -> Upload {
    var payload: [String: JSONValue] = [
      "name": .string(request.name),
      "content": .string(String(decoding: request.file, as: UTF8.self)),
      "format": .string(request.format),
      "storageUri": .string(request.storageUri),
    ]
    if let token = request.cloneToken { payload["cloneToken"] = .string(token) }
    if let archive = request.archiveOriginal { payload["archiveOriginal"] = .bool(archive) }
    storage.withLock { $0.calls.append(Call(via: "content", name: "putBinary", payload: payload)) }
    let (progress, continuation) = AsyncThrowingStream<UploadProgress, any Error>.makeStream()
    continuation.finish()
    return Upload(
      task: Task { try CreateResourceResponse(resourceId: ResourceId("uploaded")) },
      progress: Events(progress, stop: {}))
  }
}
private let callsByName:
  [String: @Sendable (SemiontClient, [String: JSONValue]) async throws -> JSONValue?] = [
    "browse.resourceContent": { client, args in
      let decodedText = try await client.browse.resourceContent(
        decoded(ResourceId.self, required(args, "resourceId")))
      #expect(decodedText == "\u{0}ÿ")
      return .string(decodedText)
    },
    "browse.resourceGraph": { client, args in
      try await encoded(
        client.browse.resourceGraph(decoded(ResourceId.self, required(args, "resourceId"))))
    },
    "browse.resourceAnchoredText": { client, args in
      try await encoded(
        client.browse.resourceAnchoredText(decoded(ResourceId.self, required(args, "resourceId"))))
    },
    "browse.resourceRepresentation": { client, args in
      let reply = try await client.browse.resourceRepresentation(
        decoded(ResourceId.self, required(args, "resourceId")))
      #expect(reply.contentType == "text/plain; charset=windows-1252")
      #expect(reply.bytes == Data([0, 255]))
      return nil
    },
    "browse.resourceRepresentationStream": { client, args in
      let stream = try await client.browse.resourceRepresentationStream(
        decoded(ResourceId.self, required(args, "resourceId")))
      defer { stream.dispose() }
      var bytes = Data()
      for try await chunk in stream { bytes.append(chunk) }
      #expect(stream.contentType == "application/octet-stream")
      #expect(bytes == Data([0, 255]))
      return nil
    },
    "yield.resource": { client, args in
      let data = try required(args, "data").object
      let upload = try client.yield.resource(
        PutBinaryRequest(
          name: required(data, "name").text, file: Data(required(data, "content").text.utf8),
          format: required(data, "format").text, storageUri: required(data, "storageUri").text))
      return try await encoded(upload.completed())
    },
    "yield.createFromToken": { client, args in
      let options = try required(args, "options").object
      return try await encoded(
        client.yield.createFromToken(
          token: required(options, "token").text, name: required(options, "name").text,
          content: required(options, "content").text,
          archiveOriginal: options["archiveOriginal"].map { try decoded(Bool.self, $0) }))
    },
    "browse.resourceEvents": { client, args in
      try await encoded(
        client.browse.resourceEvents(decoded(ResourceId.self, required(args, "resourceId"))))
    },
    "browse.annotationHistory": { client, args in
      try await encoded(
        client.browse.annotationHistory(
          resourceId: decoded(ResourceId.self, required(args, "resourceId")),
          annotationId: decoded(AnnotationId.self, required(args, "annotationId"))))
    },
    "browse.files": { client, args in
      if let path = args["dirPath"] {
        return try await encoded(
          client.browse.files(
            path.text, sort: decoded(BrowseDirectoryRequestSort.self, required(args, "sort"))))
      }
      return try await encoded(client.browse.files())
    },
    "browse.kb": { client, _ in try await encoded(client.browse.kb()) },
    "browse.click": { client, args in
      try client.browse.click(decoded(AnnotationId.self, required(args, "annotationId")))
      return nil
    },
    "browse.openResource": { client, args in
      try client.browse.openResource(decoded(ResourceId.self, required(args, "resourceId")))
      return nil
    },
    "browse.resourceViewed": { client, args in
      try client.browse.resourceViewed(decoded(ResourceId.self, required(args, "resourceId")))
      return nil
    },
    "mark.annotation": { client, args in
      try await encoded(
        client.mark.annotation(decoded(CreateAnnotationRequest.self, required(args, "input"))))
    },
    "mark.delete": { client, args in
      try await client.mark.delete(
        resourceId: decoded(ResourceId.self, required(args, "resourceId")),
        annotationId: decoded(AnnotationId.self, required(args, "annotationId")))
      return nil
    },
    "mark.archive": { client, args in
      try await client.mark.archive(decoded(ResourceId.self, required(args, "resourceId")))
      return nil
    },
    "mark.unarchive": { client, args in
      try await client.mark.unarchive(decoded(ResourceId.self, required(args, "resourceId")))
      return nil
    },
    "mark.updateEntityTypes": { client, args in
      try await client.mark.updateEntityTypes(
        resourceId: decoded(ResourceId.self, required(args, "resourceId")),
        current: decoded([String].self, required(args, "current")),
        updated: decoded([String].self, required(args, "updated")))
      return nil
    },
    "mark.request": { client, args in
      try client.mark.request(
        source: decoded(ResourceId.self, required(args, "source")),
        selector: decoded(AnnotationSelector.self, required(args, "selector")),
        motivation: decoded(Motivation.self, required(args, "motivation")))
      return nil
    },
    "mark.submit": { client, args in
      try client.mark.submit(decoded(MarkSubmitEvent.self, required(args, "input")))
      return nil
    },
    "mark.reportDeleteError": { client, args in
      try client.mark.reportDeleteError(decoded(ResourceErrorEvent.self, required(args, "input")))
      return nil
    },
    "mark.delegate": { client, args in
      try await encoded(
        client.mark.delegate(
          resourceId: decoded(ResourceId.self, required(args, "resourceId")),
          params: decoded(MarkJobParams.self, required(args, "params"))
        ).completed())
    },
    "job.status": { client, args in
      try await encoded(client.job.status(decoded(JobId.self, required(args, "jobId"))))
    },
    "job.pollUntilComplete": { client, args in
      try await encoded(client.job.pollUntilComplete(decoded(JobId.self, required(args, "jobId"))))
    },
    "job.cancel": { client, args in
      try await encoded(client.job.cancel(decoded(JobId.self, required(args, "jobId"))))
    },
    "yield.delegate": { client, args in
      let deadline = try args["stallDeadlineMs"].map { try Int(number($0)) }
      return try await encoded(
        client.yield.delegate(
          params: decoded(GenerationJobParams.self, required(args, "params")),
          stallDeadlineMs: deadline
        ).completed())
    },
    "yield.cloneToken": { client, args in
      try await encoded(
        client.yield.cloneToken(decoded(ResourceId.self, required(args, "resourceId"))))
    },
    "yield.fromToken": { client, args in
      try await encoded(client.yield.fromToken(required(args, "token").text))
    },
    "yield.clone": { client, _ in
      try client.yield.clone()
      return nil
    },
    "gather.annotation": { client, args in
      try await encoded(
        client.gather.annotation(
          resourceId: decoded(ResourceId.self, required(args, "resourceId")),
          annotationId: decoded(AnnotationId.self, required(args, "annotationId")),
          options: args["options"].map { try decoded(GatherAnnotationOptions.self, $0) }
        ).completed())
    },
    "gather.resource": { client, args in
      try await encoded(
        client.gather.resource(
          decoded(ResourceId.self, required(args, "resourceId")),
          options: args["options"].map { try decoded(GatherResourceOptions.self, $0) }))
    },
    "match.search": { client, args in
      let options = try args["options"]?.object
      if let options {
        return try await encoded(
          client.match.search(
            resourceId: decoded(ResourceId.self, required(args, "resourceId")),
            referenceId: decoded(AnnotationId.self, required(args, "referenceId")),
            context: decoded(GatheredContext.self, required(args, "context")),
            limit: decoded(Int.self, required(options, "limit")),
            useSemanticScoring: decoded(Bool.self, required(options, "useSemanticScoring"))
          ).completed())
      }
      return try await encoded(
        client.match.search(
          resourceId: decoded(ResourceId.self, required(args, "resourceId")),
          referenceId: decoded(AnnotationId.self, required(args, "referenceId")),
          context: decoded(GatheredContext.self, required(args, "context"))
        ).completed())
    },
    "match.requestSearch": { client, args in
      try client.match.requestSearch(
        decoded(MatchSearchRequest.self, required(args, "input")),
        correlationId: required(args, "correlationId").text)
      return nil
    },
    "frame.addEntityType": { client, args in
      try await client.frame.addEntityType(required(args, "type").text)
      return nil
    },
    "frame.addEntityTypes": { client, args in
      try await client.frame.addEntityTypes(decoded([String].self, required(args, "types")))
      return nil
    },
    "frame.addTagSchema": { client, args in
      try await client.frame.addTagSchema(decoded(TagSchema.self, required(args, "schema")))
      return nil
    },
    "bind.body": { client, args in
      try await client.bind.body(
        resourceId: decoded(ResourceId.self, required(args, "resourceId")),
        annotationId: decoded(AnnotationId.self, required(args, "annotationId")),
        operations: decoded([BindBodyOperation].self, required(args, "operations")))
      return nil
    },
    "bind.initiate": { client, args in
      try client.bind.initiate(decoded(BindInitiateCommand.self, required(args, "input")))
      return nil
    },
    "bind.reportBodyError": { client, args in
      try client.bind.reportBodyError(decoded(ResourceErrorEvent.self, required(args, "input")))
      return nil
    },
    "beckon.attention": { client, args in
      try await client.beckon.attention(
        resourceId: decoded(ResourceId.self, required(args, "resourceId")),
        annotationId: args["annotationId"].map { try decoded(AnnotationId.self, $0) }
      ).map { .number(Double($0)) } ?? .null
    },
    "beckon.click": { client, args in
      try await client.beckon.click(decoded(AnnotationId.self, required(args, "annotationId"))).map
      { .number(Double($0)) } ?? .null
    },
    "beckon.openResource": { client, args in
      try await client.beckon.openResource(decoded(ResourceId.self, required(args, "resourceId")))
        .map { .number(Double($0)) } ?? .null
    },
    "beckon.sparkleAll": { client, args in
      try await client.beckon.sparkleAll(decoded(AnnotationId.self, required(args, "annotationId")))
        .map { .number(Double($0)) } ?? .null
    },
    "beckon.hover": { client, args in
      try client.beckon.hover(
        args["annotationId"] == .null
          ? nil : decoded(AnnotationId.self, required(args, "annotationId")))
      return nil
    },
    "beckon.sparkle": { client, args in
      try client.beckon.sparkle(decoded(AnnotationId.self, required(args, "annotationId")))
      return nil
    },
    "auth.me": { client, _ in try await encoded(#require(client.auth).me()) },
    "auth.mediaToken": { client, args in
      try await encoded(
        #require(client.auth).mediaToken(decoded(ResourceId.self, required(args, "resourceId"))))
    },
    "auth.protectedResourceMetadata": { client, _ in
      try await encoded(#require(client.auth).protectedResourceMetadata())
    },
    "system.healthCheck": { client, _ in try await encoded(#require(client.system).healthCheck()) },
    "system.status": { client, _ in try await encoded(#require(client.system).status()) },
  ]
@Test func everyReachedNamespaceRunsEverySurfaceCase() async throws {
  let table = try Spec.read("client/surface.json").object
  var reached: Set<String> = []
  for value in try required(table, "namespaces").array {
    let namespace = try value.object
    if try namespace["notYetReached"]?.object["swift"] != nil { continue }
    let name = try required(namespace, "namespace").text
    for method in try required(namespace, "methods").array {
      let row = try method.object
      if try row["notYetReached"]?.object["swift"] != nil { continue }
      let key = name + "." + (try required(row, "method").text)
      reached.insert(key)
      let invoke = callsByName[key]
      for value in try required(row, "cases").array {
        let item = try expanded(value, fixtures: required(table, "fixtures").object).object
        let via = try required(row, "via").object
        let probe = ProbeTransport()
        surfaceReplies(probe, cloneAnswer: key == "yield.createFromToken" ? item["answers"] : nil)
        let client = try await SemiontClient(transport: probe, gateway: probe)
        defer { client.dispose() }
        let local = try via["local"].map { client.bus.listen([try $0.text]) }
        defer { local?.dispose() }
        if let observed = via["observes"] {
          let make = try #require(eventReadersByName[key])
          let read = make(client)
          probe.deliver(
            ReceivedFrame(channel: try observed.text, payload: try required(item, "sends").object))
          let result = try await within(1000) { try await read() }
          #expect(result == (try required(item, "sends")))
          #expect(probe.calls.isEmpty)
          continue
        }
        let invoke = try #require(invoke)
        let result = try await within(1000) {
          try await invoke(client, required(item, "args").object)
        }
        var expected: [Call] = []
        for (kind, name) in via {
          expected.append(
            Call(via: kind, name: try name.text, payload: try required(item, "sends").object))
        }
        for next in try item["then"]?.array ?? [] {
          let next = try next.object
          let kind = next["content"] == nil ? "request" : "content"
          expected.append(
            Call(
              via: kind, name: try required(next, kind).text,
              payload: try required(next, "sends").object))
        }
        if let local {
          let frame = try await within(1000) {
            var iterator = local.makeAsyncIterator()
            return try await iterator.next()
          }
          #expect(probe.calls.isEmpty)
          #expect(frame?.payload == expected.first?.payload)
          if let correlation = item["correlationId"] {
            #expect(frame?.correlationId == (try correlation.text))
          }
        } else {
          if via["emit"] != nil, try required(row, "shape").text == "signal" {
            try await within(5000) {
              for await sent in probe.emitted where sent { return }
            }
          }
          #expect(probe.calls == expected, "\(key)")
        }
        if try required(row, "shape").text == "count" { #expect(result == .number(7)) }
        if via["gateway"] != nil { #expect(result != nil) }
      }
    }
  }
  #expect(reached == Set(callsByName.keys).union(eventReadersByName.keys))
}

@Test func typedWirePreservesEnvelopeRefusesBadPayloadsAndKeepsReading() async throws {
  let probe = ProbeTransport()
  let bus = Bus(probe)
  let source = try await bus.frames(Channels.beckonFocus)
  let trace = ["traceparent": "00-trace-parent-01"]
  probe.deliver(
    ReceivedFrame(
      channel: "beckon:focus", correlationId: "first",
      payload: ["_userId": .string("did:web:kb.test:users:person")], trace: trace))
  probe.deliver(
    ReceivedFrame(
      channel: "beckon:focus", correlationId: "second",
      payload: [
        "resourceId": .string("res-1"), "_userId": .string("did:web:kb.test:users:person"),
        "_unrecognized": .string("ignore"),
      ], trace: trace))
  var iterator = source.makeAsyncIterator()
  guard case .refused(let bad) = try await iterator.next() else {
    Issue.record("Malformed frame delivered")
    return
  }
  #expect(bad.channel == "beckon:focus")
  #expect(bad.lacks == "resourceId")
  #expect(bad.payload["_userId"] != nil)
  guard case .delivered(let good) = try await iterator.next() else {
    Issue.record("Valid frame refused")
    return
  }
  #expect(good.payload.resourceId.value == "res-1")
  #expect(good.frame.correlationId == "second")
  #expect(good.frame.trace == trace)
  #expect(good.userId?.value == "did:web:kb.test:users:person")
  var second = source.makeAsyncIterator()
  await #expect(throws: MultipleConsumers.self) { try await second.next() }
  probe.deliver(ReceivedFrame(channel: "beckon:focus", payload: ["resourceId": .string("res-2")]))
  guard case .delivered(let third) = try await iterator.next() else {
    Issue.record("Second reader ended first")
    return
  }
  #expect(third.payload.resourceId.value == "res-2")
  source.dispose()
  #expect(try await iterator.next() == nil)
}
@Test func scopedReadsHoldOnlyTheirResourceAndReleaseAtTheEnd() async throws {
  let probe = ProbeTransport()
  let bus = Bus(probe)
  let resource = try ResourceId("res-1")
  let source = try await bus.frames(Channels.markAdded, resource: resource)
  #expect(probe.holds == 1)
  probe.deliver(ReceivedFrame(channel: "mark:added", payload: [:], scope: try ResourceId("res-2")))
  probe.deliver(
    ReceivedFrame(
      channel: "mark:added", payload: ["test-source": .string("wanted")], scope: resource))
  probe.dispose()
  var iterator = source.makeAsyncIterator()
  guard case .refused(let wanted) = try await iterator.next() else {
    Issue.record("No scoped frame")
    return
  }
  #expect(wanted.payload["test-source"] == .string("wanted"))
  #expect(try await iterator.next() == nil)
  #expect(probe.holds == 0)
  source.dispose()
  #expect(probe.holds == 0)
}
@Test func clientsBridgeOnlyReceivedFramesAndDisposeExactlyOnce() async throws {
  let probe = ProbeTransport()
  var client: SemiontClient? = try await SemiontClient(transport: probe)
  #expect(client?.auth == nil)
  #expect(client?.system == nil)
  let bus = try #require(client?.bus)
  let local = bus.frames(Channels.beckonSparkle)
  _ = try await client?.beckon.sparkleAll(AnnotationId("ann-1"))
  // Emission itself cannot loop back. Only the received copy is bridged.
  probe.deliver(
    ReceivedFrame(channel: "beckon:sparkle", payload: ["annotationId": .string("ann-2")]))
  let first = try await within(1000) {
    var iterator = local.makeAsyncIterator()
    return try await iterator.next()
  }
  guard case .delivered(let frame) = first else {
    Issue.record("Wire event was not bridged")
    return
  }
  #expect(frame.payload.annotationId.value == "ann-2")
  let closing = bus.frames(Channels.beckonSparkle)
  client?.dispose()
  client = nil
  #expect(probe.disposals == 1)
  var closingReader = closing.makeAsyncIterator()
  #expect(try await closingReader.next() == nil)
  #expect(throws: BusRequestError.self) {
    try bus.emit(Channels.beckonSparkle, BeckonSparkleEvent(annotationId: AnnotationId("ann-3")))
  }
}
@Test func namespaceRequestsPropagateFailuresAndStopSequentialWrites() async throws {
  let probe = ProbeTransport()
  let client = try await SemiontClient(transport: probe)
  defer { client.dispose() }
  probe.setFailure(BusRequestError(.busRejected, "refused"))
  do {
    try await client.frame.addEntityTypes(["first", "second"])
    Issue.record("Refusal succeeded")
  } catch let error as BusRequestError { #expect(error.reason == .busRejected) }
  #expect(probe.calls.count == 1)
  probe.reset()
  for count in [nil, 0, 11] as [Int?] {
    probe.setCount(count)
    #expect(try await client.beckon.attention(resourceId: ResourceId("res-1")) == count)
  }
}
@Test func malformedOperationRepliesFailWithoutDiscardingARequiredName() async throws {
  let probe = ProbeTransport()
  probe.handle { _, _ in [:] }
  let bus = Bus(probe)
  do {
    _ = try await bus.request(
      Operations.browseResourceRequested, BrowseResourceRequest(resourceId: ResourceId("res-1")))
    Issue.record("A malformed reply succeeded")
  } catch let error as TransportError {
    #expect(error.reason == .error)
    #expect(error.description.contains("response"))
  }
}

@Test func payloadDiagnosticsFollowTheSchemaAndPreferMissingParents() async throws {
  let probe = ProbeTransport()
  let user = try await encoded(probe.getCurrentUser()).object
  let userShape = try #require(requiredModelMembers["UserResponse"])
  let schema = try Spec.read("components/schemas/UserResponse.json").object
  #expect(userShape.lacking(in: .object(user)) == nil)
  for value in try required(schema, "required").array {
    let name = try value.text
    var missing = user
    missing.removeValue(forKey: name)
    #expect(userShape.lacking(in: .object(missing)) == name)
    missing[name] = .null
    let property = try #require(required(schema, "properties").object[name]).object
    #expect(
      userShape.lacking(in: .object(missing)) == (property["nullable"] == .bool(true) ? nil : name))
  }
  var status = try await encoded(probe.getStatus()).object
  status["features"] = .object([:])
  status.removeValue(forKey: "version")
  let statusShape = try #require(requiredModelMembers["StatusResponse"])
  #expect(statusShape.lacking(in: .object(status)) == "version")
  status["version"] = .string("test")
  #expect(statusShape.lacking(in: .object(status)) == "features.collaboration")
  let registry = try Spec.read("bus/registry.json").object
  let channels = try required(registry, "channels").array.map {
    try required($0.object, "channel").text
  }
  #expect(Set(requiredPayloadMembers.keys) == Set(channels))
}
@Test func cancellingScopedConstructionReleasesItsHold() async throws {
  let probe = ProbeTransport()
  let task = Task {
    withUnsafeCurrentTask { $0?.cancel() }
    return try await Bus(probe).frames(Channels.markAdded, resource: ResourceId("res-1"))
  }
  do {
    _ = try await task.value
    Issue.record("A cancelled scoped read opened")
  } catch is CancellationError {}
  #expect(probe.holds == 0)
}

@Test func breakingOrCancellingATypedReadReleasesItsScopeWhileTheSequenceIsHeld() async throws {
  let probe = ProbeTransport()
  let source = try await Bus(probe).frames(Channels.markAdded, resource: ResourceId("res-1"))
  probe.deliver(ReceivedFrame(channel: "mark:added", payload: [:], scope: try ResourceId("res-1")))
  for try await _ in source { break }
  #expect(probe.holds == 0)
  let waiting = try await Bus(probe).frames(Channels.markAdded, resource: ResourceId("res-2"))
  #expect(probe.holds == 1)
  let task = Task { for try await _ in waiting {} }
  task.cancel()
  _ = try await task.value
  #expect(probe.holds == 0)
  source.dispose()
  waiting.dispose()
}
private func eventReader<Payload>(_ source: Typed<Payload>)
  -> @Sendable () async throws -> JSONValue
{
  {
    var iterator = source.makeAsyncIterator()
    guard case .delivered(let frame) = try await iterator.next() else {
      throw SpecFailure.shape("No delivered event")
    }
    return try encoded(frame.payload)
  }
}
private let eventReadersByName:
  [String: @Sendable (SemiontClient) -> @Sendable () async throws -> JSONValue] = [
    "job.queued": { eventReader($0.job.queued()) },
    "job.progress": { eventReader($0.job.progress()) },
    "job.complete": { eventReader($0.job.complete()) },
    "job.fail": { eventReader($0.job.fail()) },
  ]

@Test func cancelledClientConstructionReleasesItsListenerBeforeTakingOwnership() async throws {
  let probe = ProbeTransport()
  probe.onFrames { withUnsafeCurrentTask { $0?.cancel() } }
  let task = Task { try await SemiontClient(transport: probe) }
  do {
    _ = try await task.value
    Issue.record("Cancelled constructor succeeded")
  } catch is CancellationError {}
  #expect(probe.frameEnds == 1)
  #expect(probe.disposals == 0)
  probe.dispose()
}
private struct ReadFailure: Error {}
@Test func aTypedReadReleasesItsResourceWhenItsSourceFails() async throws {
  let (stream, continuation) = AsyncThrowingStream<ReceivedFrame, any Error>.makeStream()
  let released = Watched(false)
  let source = Events(stream, stop: { continuation.finish() })
  let typed = Typed<EnrichedResourceEvent>(
    channel: Channels.markAdded.name, stamps: Channels.markAdded.stamps, source: source,
    resource: try ResourceId("res-1"), hold: ResourceHold { released.set(true) })
  continuation.finish(throwing: ReadFailure())
  var iterator = typed.makeAsyncIterator()
  await #expect(throws: ReadFailure.self) { try await iterator.next() }
  #expect(released.value)
}
@Test func requiredMemberDiagnosticsTraverseArraysAndMapsWithoutExposingTheirKeys() throws {
  let row = try #require(
    required(Spec.read("annotations/reader-cases.json").object, "cases").array.first
  ).object
  var annotation = try required(row, "annotation").object
  annotation.removeValue(forKey: "id")
  let array = JSONValue.object(["annotations": .array([.object(annotation)]), "total": .number(1)])
  let listShape = try #require(requiredModelMembers["GetAnnotationsResponse"])
  #expect(listShape.lacking(in: array) == "annotations.id")
  let cursor = UnitCursor(emitted: 2, errors: 0, found: 3, next: 20, size: 100)
  let failed = try JobFailCommand(
    error: "failure", jobId: JobId("job-1"), jobType: .mark, resourceId: ResourceId("res-1"),
    unitCursors: ["some-unit": cursor])
  var payload = try wirePayload(failed)
  var incomplete = try wirePayload(cursor)
  incomplete.removeValue(forKey: "size")
  payload["unitCursors"] = .object(["some-unit": .object(incomplete)])
  let mapShape = try #require(requiredModelMembers["JobFailCommand"])
  #expect(mapShape.lacking(in: .object(payload)) == "unitCursors.size")
}
