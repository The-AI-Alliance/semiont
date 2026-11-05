import SemiontTesting
import Synchronization
import Testing

@testable import Semiont

struct StateReading: Sendable {
  let value: @Sendable () throws -> JSONValue
  let ended: @Sendable () async throws -> Bool

  init<Value>(_ watched: Watched<Value>, encode: @escaping @Sendable (Value) throws -> JSONValue) {
    value = { try encode(watched.value) }
    ended = {
      try await within(testDeadlineMs) {
        var iterator = watched.makeAsyncIterator()
        _ = await iterator.next()
        if case .some = await iterator.next() { return false }
        try Task.checkCancellation()
        return true
      }
    }
  }

  init<Value: Encodable>(_ watched: Watched<Value>) {
    self.init(watched) { try encoded($0) }
  }

  init(_ watched: Watched<(any Error)?>) {
    self.init(watched) { error in
      guard let error else { return .null }
      let code: String? =
        switch error {
        case let error as JobError: error.code
        case let error as BusRequestError: error.code
        case let error as TransportError: error.code
        default: nil
        }
      var object: [String: JSONValue] = ["message": .string(String(describing: error))]
      if let code { object["code"] = .string(code) }
      return .object(object)
    }
  }
}

final class StateCaseSearch: Sendable {
  private struct Request: Sendable {
    let text: String
    let continuation: AsyncStream<[String]?>.Continuation
  }

  private let requests = Mutex<[Request]>([])
  var queries: [String] { requests.withLock { $0.map(\.text) } }

  func search(_ text: String) -> AsyncStream<[String]?> {
    let (stream, continuation) = AsyncStream<[String]?>.makeStream()
    requests.withLock { $0.append(Request(text: text, continuation: continuation)) }
    return stream
  }

  func answer(_ index: Int, with results: [String]?) throws {
    let request = requests.withLock { $0.dropFirst(index).first }
    guard let request else { throw SpecFailure.shape("Unasked search \(index)") }
    request.continuation.yield(results)
  }
}

struct StateCaseUnit {
  let unit: any StateUnit
  let reading: [String: StateReading]

  init(
    _ kind: String, options: [String: JSONValue], client: SemiontClient, clock: TestClock,
    search: StateCaseSearch
  ) throws {
    func resourceId() throws -> ResourceId {
      try decoded(ResourceId.self, required(options, "resourceId"))
    }
    switch kind {
    case "mark":
      let mark = MarkStateUnit(client: client, resourceId: try resourceId(), clock: clock)
      unit = mark
      reading = [
        "pendingAnnotation": StateReading(mark.pendingAnnotation),
        "delegatingMotivation": StateReading(mark.delegatingMotivation),
        "progress": StateReading(mark.progress),
        "progressMotivation": StateReading(mark.progressMotivation),
        "failure": StateReading(mark.failure), "jobId": StateReading(mark.jobId),
      ]
    case "yield":
      let yield = YieldStateUnit(client: client, locale: try required(options, "locale").text)
      unit = yield
      reading = [
        "isGenerating": StateReading(yield.isGenerating), "progress": StateReading(yield.progress),
        "outcome": StateReading(yield.outcome), "failure": StateReading(yield.failure),
        "jobId": StateReading(yield.jobId),
      ]
    case "gather":
      let gather = GatherStateUnit(client: client, resourceId: try resourceId())
      unit = gather
      reading = [
        "context": StateReading(gather.context), "loading": StateReading(gather.loading),
        "error": StateReading(gather.error), "annotationId": StateReading(gather.annotationId),
        "resourceContext": StateReading(gather.resourceContext),
        "resourceLoading": StateReading(gather.resourceLoading),
        "resourceError": StateReading(gather.resourceError),
      ]
    case "match":
      unit = MatchStateUnit(client: client)
      reading = [:]
    case "beckon":
      let beckon = BeckonStateUnit(client: client, resourceId: try resourceId())
      unit = beckon
      reading = ["hoveredAnnotationId": StateReading(beckon.hoveredAnnotationId)]
    case "hoverDwell":
      let delay = try options["delayMs"].map(stateCaseDuration)
      unit = HoverDwell(delay: delay, clock: clock) { [beckon = client.beckon] id in
        try? beckon.hover(id)
      }
      reading = [:]
    case "search":
      let pipeline = SearchPipeline(
        initialQuery: try options["initialQuery"]?.text ?? "",
        debounce: try options["debounceMs"].map(stateCaseDuration),
        clock: clock, search: search.search)
      unit = pipeline
      reading = ["query": StateReading(pipeline.query), "state": StateReading(pipeline.state)]
    case "sessionSignals":
      let signals = SessionSignals()
      unit = signals
      reading = [
        "sessionEnded": StateReading(signals.sessionEnded),
        "permissionDenied": StateReading(signals.permissionDenied),
        "kbIdentityConflict": StateReading(signals.kbIdentityConflict),
      ]
    default: throw SpecFailure.shape("Unknown state unit \(kind)")
    }
  }

  func invoke(_ method: String, args: [String: JSONValue]) throws {
    func argument<Value: Decodable>(_ type: Value.Type, _ name: String) throws -> Value {
      try decoded(type, required(args, name))
    }

    switch (unit, method) {
    case (let mark as MarkStateUnit, "requestDelegate"):
      mark.requestDelegate(try argument(MarkJobParams.self, "params"))
    case (let mark as MarkStateUnit, "cancelPending"): mark.cancelPending()
    case (let mark as MarkStateUnit, "dismissProgress"): mark.dismissProgress()
    case (let yield as YieldStateUnit, "generate"):
      yield.generate(
        try argument(GenerationJobParams.self, "params"),
        stallDeadlineMs: try args["stallDeadlineMs"].map(stateCaseInteger))
    case (let yield as YieldStateUnit, "dismissProgress"): yield.dismissProgress()
    case (let gather as GatherStateUnit, "gatherAnnotation"):
      let id = try argument(AnnotationId.self, "annotationId")
      let options = try decoded(
        GatherAnnotationOptions.self, .object(args.filter { $0.key != "annotationId" }))
      gather.gatherAnnotation(id, options: options)
    case (let gather as GatherStateUnit, "gatherResource"):
      let id = try argument(ResourceId.self, "resourceId")
      let options = try decoded(
        GatherResourceOptions.self, .object(args.filter { $0.key != "resourceId" }))
      gather.gatherResource(id, options: options)
    case (let beckon as BeckonStateUnit, "focus"):
      beckon.focus(try argument(AnnotationId.self, "annotationId"))
    case (let dwell as HoverDwell, "enter"):
      dwell.enter(try argument(AnnotationId.self, "annotationId"))
    case (let dwell as HoverDwell, "leave"): dwell.leave()
    case (let search as SearchPipeline<String>, "setQuery"):
      search.setQuery(try required(args, "value").text)
    case (let signals as SessionSignals, "notifySessionEnded"):
      signals.notifySessionEnded(try argument(SessionEndReason.self, "reason"))
    case (let signals as SessionSignals, "notifyPermissionDenied"):
      signals.notifyPermissionDenied(try argument(String?.self, "detail"))
    case (let signals as SessionSignals, "notifyKbIdentityConflict"):
      signals.notifyKbIdentityConflict(try argument(KbIdentityConflict.self, "conflict"))
    case (let signals as SessionSignals, "acknowledgeSessionEnded"):
      signals.acknowledgeSessionEnded()
    case (let signals as SessionSignals, "acknowledgePermissionDenied"):
      signals.acknowledgePermissionDenied()
    case (let signals as SessionSignals, "acknowledgeKbIdentityConflict"):
      signals.acknowledgeKbIdentityConflict()
    default: throw SpecFailure.shape("Unknown state unit method \(method)")
    }
  }
}
