import Foundation
import Synchronization

final class ScopedQueries<Value: Sendable>: Sendable {
  private let entries = Mutex<[ResourceId: Cached<Value>]>([:])
  private let transport: any Transport
  private let lifetime: Lifetime
  private let fetch: @Sendable (ResourceId) async throws -> Value

  init(
    transport: any Transport, lifetime: Lifetime,
    fetch: @escaping @Sendable (ResourceId) async throws -> Value
  ) {
    self.transport = transport
    self.lifetime = lifetime
    self.fetch = fetch
    lifetime.onEnd { [weak self] in
      self?.entries.withLock { $0.removeAll() }
    }
  }

  func query(_ resource: ResourceId) -> Cached<Value> {
    let transport = transport
    let fetch = fetch
    return entries.withLock { entries in
      if let query = entries[resource] { return query }
      let query = Cached(
        lifetime: lifetime, hold: { await transport.subscribeToResource(resource) }
      ) {
        try await fetch(resource)
      }
      if !lifetime.ended { entries[resource] = query }
      return query
    }
  }

  func refresh(scope: ResourceId?, coalescing: Bool) async {
    let queries = entries.withLock { entries in
      guard let scope else { return Array(entries.values) }
      return entries[scope].map { [$0] } ?? []
    }
    for query in queries { await query.refreshIfKnown(coalescing: coalescing) }
  }
}

struct LiveQueries: Sendable {
  private enum Query: String, CaseIterable {
    case entityTypes, tagSchemas, resource, events, referencedBy
  }
  let entityTypes: Cached<[String]>
  let tagSchemas: Cached<[TagSchema]>
  let resources: ScopedQueries<ResourceDescriptor>
  let events: ScopedQueries<[AttributedEvent]>
  let referencedBy: ScopedQueries<[GetReferencedByResponseReferencedByItem]>

  init(wire: Bus, transport: any Transport, lifetime: Lifetime) {
    entityTypes = Cached(lifetime: lifetime) {
      try await wire.request(Operations.browseEntityTypesRequested, BrowseEntityTypesRequest())
        .response.entityTypes
    }
    tagSchemas = Cached(lifetime: lifetime) {
      try await wire.request(Operations.browseTagSchemasRequested, BrowseTagSchemasRequest())
        .response.tagSchemas
    }
    resources = ScopedQueries(transport: transport, lifetime: lifetime) { resource in
      try await wire.request(
        Operations.browseResourceRequested, BrowseResourceRequest(resourceId: resource)
      ).response.resource
    }
    events = ScopedQueries(transport: transport, lifetime: lifetime) { resource in
      try await wire.request(
        Operations.browseEventsRequested, BrowseEventsRequest(resourceId: resource)
      ).response.events
    }
    referencedBy = ScopedQueries(transport: transport, lifetime: lifetime) { resource in
      try await wire.request(
        Operations.gatherReferencedByRequested, GatherReferencedByRequest(resourceId: resource)
      ).response.referencedBy
    }
  }

  func reopened() async {
    for rule in cacheRefresh where rule.on == "reopened" {
      await refresh(
        (rule.refetches ?? []).compactMap(Query.init(rawValue:)), scope: nil, coalescing: false)
    }
  }

  func receive(_ frame: ReceivedFrame) async {
    let rules = cacheRefresh.compactMap { rule -> (SpecCacheRefreshItem, [Query])? in
      guard rule.on == frame.channel else { return nil }
      let queries = (rule.refetches ?? []).compactMap(Query.init(rawValue:))
      return queries.isEmpty ? nil : (rule, queries)
    }
    guard !rules.isEmpty else { return }
    do {
      let data = try JSONEncoder().encode(frame.payload)
      let decoder = JSONDecoder()
      let scope: ResourceId?
      let condition: String?
      switch frame.channel {
      case Channels.busResumeGap.name:
        scope = try decoder.decode(BusResumeGap.self, from: data).scope
        condition = nil
      case Channels.markBodyUpdated.name:
        let event = try decoder.decode(EnrichedResourceEvent.self, from: data)
        scope = event.resourceId
        condition = event.annotation == nil ? "unenriched" : "enriched"
      default:
        scope = try decoder.decode(StoredEventResponse.self, from: data).resourceId
        condition = nil
      }
      for (rule, queries) in rules where rule.when == condition {
        await refresh(queries, scope: rule.reach == "held" ? nil : scope, coalescing: true)
      }
    } catch {
      // A malformed event cannot identify what changed. Recheck the known entries.
      await refresh(Query.allCases, scope: nil, coalescing: true)
    }
  }

  private func refresh(_ queries: [Query], scope: ResourceId?, coalescing: Bool) async {
    for query in queries {
      switch query {
      case .entityTypes: await entityTypes.refreshIfKnown(coalescing: coalescing)
      case .tagSchemas: await tagSchemas.refreshIfKnown(coalescing: coalescing)
      case .resource: await resources.refresh(scope: scope, coalescing: coalescing)
      case .events: await events.refresh(scope: scope, coalescing: coalescing)
      case .referencedBy:
        await referencedBy.refresh(scope: scope, coalescing: coalescing)
      }
    }
  }
}
