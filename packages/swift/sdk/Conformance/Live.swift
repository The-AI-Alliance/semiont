import AsyncHTTPClient
import Foundation
import Semiont

private struct Query: Sendable {
  let fresh: @Sendable () async throws -> JSONValue
  let invalidate: @Sendable () async -> Void
  let observe: @Sendable (String, Output, AsyncStream<Void>.Continuation) async -> Void

  init<Value: Encodable & Sendable>(_ cache: Cached<Value>) {
    fresh = { try await encoded(cache.fresh()) }
    invalidate = { await cache.invalidate() }
    observe = { name, output, first in
      defer { first.finish() }
      for await state in cache {
        let written: [String: JSONValue]
        switch state {
        case .pending: written = ["status": .string("pending")]
        case .ready(let value):
          do { written = ["status": .string("ready"), "value": try encoded(value)] } catch {
            written = ["status": .string("failed"), "error": failure(error)]
          }
        case .failed(let error): written = ["status": .string("failed"), "error": failure(error)]
        }
        await output.emission(name, written)
        first.yield()
      }
      if !Task.isCancelled { await output.say(["completed": .string(name)]) }
    }
  }
}

extension Output {
  fileprivate func emission(_ observer: String, _ state: [String: JSONValue]) {
    say(["emission": .object(["observer": .string(observer), "state": .object(state)])])
  }
}

private func decode<Value: Decodable>(_ type: Value.Type, _ value: [String: JSONValue]) throws
  -> Value
{
  try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
}

private func resourceFilters(_ query: [String: JSONValue]) throws -> ResourceFilters {
  guard query["filters"] != nil else { return ResourceFilters() }
  let filters = try query.object("filters")
  guard Set(filters.keys).isSubset(of: ["archived", "entityType", "limit", "offset"]) else {
    throw Misuse(description: "Unknown resource filter")
  }
  return try ResourceFilters(
    archived: filters.optionalBool("archived"), entityType: filters.optionalText("entityType"),
    limit: filters["limit"] == nil ? 100 : filters.integer("limit"),
    offset: filters["offset"] == nil ? 0 : filters.integer("offset"))
}

private func namedQuery(_ client: SemiontClient, _ query: [String: JSONValue]) throws -> Query {
  switch try query.text("query") {
  case "resource": return try Query(client.browse.resource(ResourceId(query.text("resource"))))
  case "annotations":
    return try Query(client.browse.annotations(ResourceId(query.text("resource"))))
  case "annotation":
    return try Query(
      client.browse.annotation(
        resourceId: ResourceId(query.text("resource")),
        annotationId: AnnotationId(query.text("annotation"))))
  case "events": return try Query(client.browse.events(ResourceId(query.text("resource"))))
  case "referencedBy":
    return try Query(client.gather.referencedBy(ResourceId(query.text("resource"))))
  case "resources": return try Query(client.browse.resources(filters: resourceFilters(query)))
  case "matchedResources":
    return try Query(client.match.resources(query.text("search"), filters: resourceFilters(query)))
  case "entityTypes": return Query(client.browse.entityTypes())
  case "tagSchemas": return Query(client.browse.tagSchemas())
  case "engines": return Query(client.browse.engines())
  case let name: throw Misuse(description: "No live query named \(name)")
  }
}

actor LiveDriver {
  static let operations: Set<String> = [
    "open", "close", "observe", "unobserve", "fresh", "invalidate", "delete", "markDelegate",
    "yieldDelegate", "sync",
  ]
  static let immediate: Set<String> = [
    "observe", "unobserve", "invalidate", "markDelegate", "yieldDelegate",
  ]

  let output: Output
  let http: HTTPClient
  let storage = MemorySessionStorage()
  var client: SemiontClient?
  var closed = true
  var observers: [String: Task<Void, Never>] = [:]
  var reporters: [Task<Void, Never>] = []

  init(output: Output, http: HTTPClient) {
    self.output = output
    self.http = http
  }

  private func current() throws -> SemiontClient {
    guard let client else { throw Misuse(description: "No client is open") }
    return client
  }

  private func open(_ args: [String: JSONValue]) async throws {
    guard closed else { throw Misuse(description: "A client is already open") }
    var transportTiming = TransportTiming()
    var window: Int?
    var silence: Int?
    var statusPoll: Int?
    if args["timing"] != nil {
      let timing = try args.object("timing")
      for name in timing.keys {
        let value = try timing.integer(name)
        guard value >= 0 else { throw Misuse(description: "Negative timing \(name)") }
        switch name {
        case "reconnectMs": transportTiming.reconnectMs = value
        case "lazyRemoveMs": transportTiming.lazyRemoveMs = value
        case "lingerMs": transportTiming.lingerMs = value
        case "busRequestTimeoutMs": transportTiming.busRequestTimeoutMs = value
        case "invalidationWindowMs": window = value
        case "jobSilenceMs": silence = value
        case "jobStatusPollMs": statusPoll = value
        default: throw Misuse(description: "Unknown timing override \(name)")
        }
      }
    }
    let persistence =
      try args.optionalBool("persist") == true
      ? CachePersistence(storage: storage, keyPrefix: "conformance") : nil
    let transport = HttpTransport(
      baseUrl: try args.text("baseUrl"), httpClient: http, token: try args.text("token"),
      timing: transportTiming)
    let failures = transport.failures()
    do {
      client = try await SemiontClient(
        transport: transport, gateway: transport,
        followTiming: FollowTiming(silenceMs: silence, statusPollMs: statusPoll),
        persistence: persistence, invalidationWindowMs: window)
    } catch {
      transport.dispose()
      throw error
    }
    closed = false
    let output = output
    reporters = [
      Task {
        for await state in transport.state { await output.say(["state": .string(state.rawValue)]) }
      },
      Task {
        do { for try await error in failures { await output.say(["error": failure(error)]) } } catch
        {}
      },
    ]
  }

  private func free(_ args: [String: JSONValue]) throws -> String {
    let observer = try args.text("observer")
    guard observers[observer] == nil else { throw Misuse(description: "\(observer) is observing") }
    return observer
  }

  private func follow<Value: Encodable & Sendable>(
    _ observer: String, _ job: Delegation<Value>
  ) {
    let output = output
    observers[observer] = Task {
      do {
        for try await event in job {
          let kind: String
          let data: JSONValue
          switch event {
          case .created(let value):
            kind = "created"
            data = try encoded(value)
          case .progress(let value):
            kind = "progress"
            data = try encoded(value)
          case .failed(let value):
            kind = "failed"
            data = try encoded(value)
          case .complete(let value):
            kind = "complete"
            data = try encoded(value)
          }
          await output.emission(
            observer,
            ["status": .string("ready"), "value": .object(["kind": .string(kind), "data": data])])
        }
      } catch {
        if !Task.isCancelled {
          await output.emission(observer, ["status": .string("failed"), "error": failure(error)])
        }
      }
      if !Task.isCancelled { await output.say(["completed": .string(observer)]) }
    }
  }

  func run(_ op: String, args: [String: JSONValue]) async throws -> JSONValue {
    switch op {
    case "open": try await open(args)
    case "close":
      try current().dispose()
      closed = true
      for reporter in reporters { await reporter.value }
      for observer in observers.values { await observer.value }
      reporters.removeAll()
      observers.removeAll()
    case "observe":
      let observer = try free(args)
      let query = try namedQuery(current(), args.object("query"))
      let (first, signal) = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
      let output = output
      observers[observer] = Task { await query.observe(observer, output, signal) }
      var initial = first.makeAsyncIterator()
      _ = await initial.next()
    case "unobserve":
      let observer = try args.text("observer")
      guard let task = observers.removeValue(forKey: observer) else {
        throw Misuse(description: "\(observer) is not observing")
      }
      task.cancel()
      await task.value
    case "fresh":
      return try await .object(["value": namedQuery(current(), args.object("query")).fresh()])
    case "invalidate":
      try await namedQuery(current(), args.object("query")).invalidate()
    case "delete":
      try await current().mark.delete(
        resourceId: ResourceId(args.text("resource")),
        annotationId: AnnotationId(args.text("annotation")))
    case "markDelegate":
      let observer = try free(args)
      let job = try current().mark.delegate(
        resourceId: ResourceId(args.text("resource")),
        params: decode(MarkJobParams.self, args.object("params")))
      follow(observer, job)
    case "yieldDelegate":
      let observer = try free(args)
      let job = try current().yield.delegate(
        params: decode(GenerationJobParams.self, args.object("params")),
        stallDeadlineMs: args.integer("stallDeadlineMs"))
      follow(observer, job)
    case "sync": break
    default: throw Misuse(description: "Unknown live operation \(op)")
    }
    return .null
  }

  func finish() async {
    client?.dispose()
    let tasks = Array(observers.values) + reporters
    for task in tasks { task.cancel() }
    for task in tasks { await task.value }
  }
}
