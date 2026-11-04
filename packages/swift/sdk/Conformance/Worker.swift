import AsyncHTTPClient
import Foundation
import Semiont

extension Dictionary where Key == String, Value == JSONValue {
  fileprivate func decoded<T: Decodable>(_ key: String, as type: T.Type) throws -> T {
    guard let value = self[key] else { throw Misuse(description: "\(key) is required") }
    do {
      return try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    } catch {
      throw Misuse(description: "\(key) is invalid: \(error)")
    }
  }

  fileprivate func optional<T: Decodable>(_ key: String, as type: T.Type) throws -> T? {
    guard self[key] != nil else { return nil }
    return try decoded(key, as: type)
  }
}

actor WorkerDriver {
  static let operations: Set<String> = [
    "open", "close", "subscribe-resource", "claim", "start", "progress", "checkpoint", "commit",
    "complete", "fail", "cancel", "vitals", "sync",
  ]
  static let immediate: Set<String> = ["claim", "vitals"]

  let output: Output
  let http: HTTPClient
  var client: SemiontClient?
  var transport: HttpTransport?
  var timing = WorkerTiming()
  var claims: Claims?
  var held: (any HeldJob)?
  var scopes: [ResourceHold] = []
  var reporters: [Task<Void, Never>] = []

  init(output: Output, http: HTTPClient) {
    self.output = output
    self.http = http
  }

  private func open(_ args: [String: JSONValue]) async throws {
    guard client == nil else { throw Misuse(description: "The worker is already open") }
    var transportTiming = TransportTiming()
    var claim: Int?
    var stall: Int?
    var check: Int?
    var commit: Int?
    if args["timing"] != nil {
      let timing = try args.object("timing")
      for name in timing.keys {
        let value = try timing.integer(name)
        guard value >= 0 else { throw Misuse(description: "Negative timing \(name)") }
        switch name {
        case "reconnectMs": transportTiming.reconnectMs = value
        case "lazyRemoveMs": transportTiming.lazyRemoveMs = value
        case "lingerMs": transportTiming.lingerMs = value
        case "jobClaimTimeoutMs": claim = value
        case "heldJobStallMs": stall = value
        case "heldJobStallCheckMs": check = value
        case "markCommitTimeoutMs": commit = value
        default: throw Misuse(description: "Unknown timing override \(name)")
        }
      }
    }
    self.timing = WorkerTiming(
      claimTimeoutMs: claim, stallMs: stall, stallCheckMs: check, commitTimeoutMs: commit)
    var channels = jobClaimChannels
    if try args.optionalBool("commits") == true { channels += jobCommitChannels }
    let transport = HttpTransport(
      baseUrl: try args.text("baseUrl"), httpClient: http, token: try args.text("token"),
      channels: channels.sorted(), timing: transportTiming)
    let failures = transport.failures()
    do {
      client = try await SemiontClient(transport: transport)
    } catch {
      transport.dispose()
      throw error
    }
    self.transport = transport
    let output = output
    reporters.append(
      Task {
        for await state in transport.state { await output.say(["state": .string(state.rawValue)]) }
      })
    reporters.append(
      Task {
        do { for try await error in failures { await output.say(["error": failure(error)]) } } catch
        {}
      })
  }

  private func claimed(_ job: any HeldJob) async {
    held = job
    do {
      let fields: [String: JSONValue] = [
        "jobId": try encoded(job.jobId), "jobType": try encoded(job.jobType),
        "resourceId": try encoded(job.resourceId), "params": try encoded(job.params),
        "completedUnits": try encoded(job.completedUnits),
        "unitCursors": try encoded(job.unitCursors),
        "retryCount": .number(Double(job.retryCount)),
        "maxRetries": .number(Double(job.maxRetries)),
      ]
      await output.say(["claimed": .object(fields)])
    } catch {
      await output.say(["error": failure(error)])
    }
    let output = output
    reporters.append(
      Task {
        for await signal in job.cancelled where signal {
          await output.say(["signalled": .string(job.jobId.value)])
          break
        }
      })
  }

  private func startClaims(_ accepts: [JobFilter]) throws {
    guard let client else { throw Misuse(description: "The worker is closed") }
    guard claims == nil else { throw Misuse(description: "The worker is already claiming") }
    let claims = client.job.claim(accepts, timing: timing)
    self.claims = claims
    let output = output
    let refused = claims.refused()
    reporters.append(
      Task {
        do {
          for try await error in refused {
            var fields: [String: JSONValue] = ["detail": .string(error.detail)]
            if let code = error.code { fields["code"] = .string(code.rawValue) }
            await output.say(["refused": .object(fields)])
          }
        } catch {}
      })
    reporters.append(
      Task {
        for await stall in claims.stalled {
          if let stall { await output.say(["stalled": .string(stall.jobId.value)]) }
        }
      })
    reporters.append(
      Task { [weak self] in
        for await job in claims { await self?.claimed(job) }
      })
  }

  private func working() throws -> any HeldJob {
    guard let held else { throw Misuse(description: "The worker has held no job") }
    return held
  }

  private func vitals() async throws -> JSONValue {
    guard let claims else { throw Misuse(description: "The worker is not claiming") }
    let vitals = await claims.vitals
    func time(_ date: Date?) -> JSONValue {
      date.map { .string($0.formatted(.iso8601.time(includingFractionalSeconds: true))) } ?? .null
    }
    let active: JSONValue
    if let job = vitals.activeJob {
      active = .object([
        "jobId": .string(job.jobId.value), "type": .string(job.jobType.rawValue),
        "since": time(job.since),
      ])
    } else {
      active = .null
    }
    return .object([
      "lastQueuedEventAt": time(vitals.lastQueuedEventAt), "lastClaimAt": time(vitals.lastClaimAt),
      "lastFinishedAt": time(vitals.lastFinishedAt), "lastActivityAt": time(vitals.lastActivityAt),
      "activeJob": active, "jobsCompleted": .number(Double(vitals.jobsCompleted)),
    ])
  }

  func run(_ op: String, args: [String: JSONValue]) async throws -> JSONValue {
    switch op {
    case "open": try await open(args)
    case "close":
      await claims?.stop()
      client?.dispose()
      for reporter in reporters { await reporter.value }
      reporters.removeAll()
      scopes.removeAll()
    case "claim": try startClaims(args.decoded("accepts", as: [JobFilter].self))
    case "subscribe-resource":
      guard let transport else { throw Misuse(description: "The worker is closed") }
      let resource = try ResourceId(args.text("resource"))
      scopes.append(await transport.subscribeToResource(resource))
    case "start": try await working().start()
    case "progress":
      let percentage = try args.decoded("percentage", as: Double.self)
      let message = try args.optional("message", as: JobProgressMessage.self)
      try await working().progress(JobProgress(message: message, percentage: percentage))
    case "checkpoint":
      try await working().checkpoint(
        completedUnits: args.texts("completedUnits"),
        unitCursors: args.optional("unitCursors", as: [String: UnitCursor].self))
    case "commit":
      try await working().commit(
        resourceId: ResourceId(args.text("resourceId")),
        annotations: args.decoded("annotations", as: [Annotation].self))
    case "complete":
      let job = try working()
      if let mark = job as? any HeldMarkJob {
        try await mark.complete(args.decoded("result", as: MarkJobResult.self))
      } else if let yield = job as? any HeldYieldJob {
        try await yield.complete(args.decoded("result", as: YieldJobResult.self))
      } else {
        throw Misuse(description: "The held job has no supported verb")
      }
    case "fail":
      try await working().fail(
        args.text("error"), failureClass: args.optional("failureClass", as: FailureClass.self),
        completedUnits: args.optional("completedUnits", as: [String].self),
        unitCursors: args.optional("unitCursors", as: [String: UnitCursor].self))
    case "cancel":
      try await working().cancel(
        completedUnits: args.optional("completedUnits", as: [String].self),
        unitCursors: args.optional("unitCursors", as: [String: UnitCursor].self))
    case "vitals": return try await vitals()
    case "sync": break
    default: throw Misuse(description: "Unknown worker operation \(op)")
    }
    return .null
  }

  func finish() async {
    // EOF ends the driver without settling an owned job.
    client?.dispose()
    for reporter in reporters { reporter.cancel() }
    for reporter in reporters { await reporter.value }
    held = nil
  }
}
