/// The page and filters for browsing or searching a knowledge base's resources.
public struct ResourceFilters: Hashable, Sendable {
  public var archived: Bool?
  public var entityType: String?
  public var limit: Int
  public var offset: Int

  public init(
    archived: Bool? = nil, entityType: String? = nil, limit: Int = 100, offset: Int = 0
  ) {
    self.archived = archived
    self.entityType = entityType
    self.limit = limit
    self.offset = offset
  }
}

/// An engine in the knowledge base and any limits reported by its credential holder.
public struct EngineWithLimits: Encodable, Sendable {
  public let engine: Engine
  public let jobs: [JobFilter]?
  public let limits: InferenceLimits?
}

func browseEngines(_ wire: Bus) async throws -> [EngineWithLimits] {
  let (queued, sent) = AsyncStream<Void>.makeStream()
  async let catalog: BrowseEnginesResult = {
    defer { sent.finish() }
    return try await wire.request(
      Operations.browseEnginesRequested, BrowseEnginesRequest(), enqueued: { sent.yield() })
  }()
  var waiting = queued.makeAsyncIterator()
  guard await waiting.next() != nil else {
    // A request that could not be sent cannot have any engine entries to join.
    _ = try await catalog
    throw CancellationError()
  }
  async let reports = engineLimits(wire)
  let entries = try await catalog.response.engines
  let reported = await reports
  try Task.checkCancellation()
  return entries.map { entry in
    let limits = reported.first {
      $0.engine.provider == entry.engine.provider && $0.engine.model == entry.engine.model
    }?.limits
    return EngineWithLimits(engine: entry.engine, jobs: entry.jobs, limits: limits)
  }
}

private func engineLimits(_ wire: Bus) async -> [EngineLimits] {
  await withTaskGroup(of: (Int, [EngineLimits]).self) { group in
    for (index, operation) in Operations.limits.enumerated() {
      group.addTask {
        let answer = try? await wire.request(operation, InferenceLimitsRequest())
        return (index, answer?.response.limits ?? [])
      }
    }
    var received: [(Int, [EngineLimits])] = []
    for await report in group { received.append(report) }
    return received.sorted { $0.0 < $1.0 }.flatMap { $0.1 }
  }
}
