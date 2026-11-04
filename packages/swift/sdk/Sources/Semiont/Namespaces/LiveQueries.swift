import Foundation
import Synchronization

final class KeyedQueries<Key: Hashable & Sendable, Value: Sendable>: Sendable {
  private let entries = Mutex<[Key: Cached<Value>]>([:])
  private let transport: any Transport
  private let lifetime: Lifetime
  private let scope: (@Sendable (Key) -> ResourceId)?
  private let kept: (@Sendable (Key) -> KeptValue<Value>?)?
  private let invalidationWindowMs: Int
  private let fetch: @Sendable (Key) async throws -> Value

  init(
    transport: any Transport, lifetime: Lifetime, scope: (@Sendable (Key) -> ResourceId)? = nil,
    kept: (@Sendable (Key) -> KeptValue<Value>?)? = nil, invalidationWindowMs: Int,
    fetch: @escaping @Sendable (Key) async throws -> Value
  ) {
    self.transport = transport
    self.lifetime = lifetime
    self.scope = scope
    self.kept = kept
    self.invalidationWindowMs = invalidationWindowMs
    self.fetch = fetch
    lifetime.onEnd { [weak self] in
      self?.entries.withLock { $0.removeAll() }
    }
  }

  func query(_ key: Key) -> Cached<Value> {
    let transport = transport
    let fetch = fetch
    let hold: (@Sendable () async -> ResourceHold)?
    if let resource = scope?(key) {
      hold = { await transport.subscribeToResource(resource) }
    } else {
      hold = nil
    }
    return entries.withLock { entries in
      if let query = entries[key] { return query }
      let query = Cached(
        lifetime: lifetime, hold: hold, kept: kept?(key), invalidationWindowMs: invalidationWindowMs
      ) {
        try await fetch(key)
      }
      if !lifetime.ended { entries[key] = query }
      return query
    }
  }

  func existing(_ key: Key) -> Cached<Value>? { entries.withLock { $0[key] } }

  func matching(_ matches: (Key) -> Bool) -> [Cached<Value>] {
    entries.withLock { entries in entries.compactMap { matches($0.key) ? $0.value : nil } }
  }

  func refresh(_ key: Key?, coalescing: Bool) async {
    if let key {
      await existing(key)?.refreshIfKnown(coalescing: coalescing)
      return
    }
    for query in matching({ _ in true }) { await query.refreshIfKnown(coalescing: coalescing) }
  }
}

struct LiveQueries: Sendable {
  private enum Query: String, CaseIterable {
    case entityTypes, tagSchemas, resource, events, referencedBy, annotations, annotation
    case resources, matchedResources, engines
  }
  struct SearchKey: Hashable, Sendable {
    let text: String
    let filters: ResourceFilters
  }

  private struct AnnotationKey: Hashable, Sendable {
    let resource: ResourceId
    let annotation: AnnotationId
  }

  private struct Subject {
    var resource: ResourceId?
    var annotation: AnnotationId?
    var value: Annotation?
    var condition: String?
  }

  let entityTypes: Cached<[String]>
  let tagSchemas: Cached<[TagSchema]>
  let resources: KeyedQueries<ResourceId, ResourceDescriptor>
  let events: KeyedQueries<ResourceId, [AttributedEvent]>
  let referencedBy: KeyedQueries<ResourceId, [GetReferencedByResponseReferencedByItem]>
  let annotations: KeyedQueries<ResourceId, [Annotation]>
  let listedResources: KeyedQueries<ResourceFilters, ListResourcesResponse>
  let matchedResources: KeyedQueries<SearchKey, MatchResourcesResponse>
  let engines: Cached<[EngineWithLimits]>
  private let details: KeyedQueries<AnnotationKey, Annotation>

  init(
    wire: Bus, transport: any Transport, content: (any ContentTransport)?, lifetime: Lifetime,
    book: CacheBook?, invalidationWindowMs: Int
  ) {
    listedResources = KeyedQueries(
      transport: transport, lifetime: lifetime, invalidationWindowMs: invalidationWindowMs
    ) { filters in
      try await wire.request(
        Operations.browseResourcesRequested,
        BrowseResourcesRequest(
          archived: filters.archived, entityType: filters.entityType, limit: filters.limit,
          offset: filters.offset)
      ).response
    }
    matchedResources = KeyedQueries(
      transport: transport, lifetime: lifetime, invalidationWindowMs: invalidationWindowMs
    ) { search in
      let filters = search.filters
      return try await wire.request(
        Operations.matchResourcesRequested,
        MatchResourcesRequest(
          archived: filters.archived, entityType: filters.entityType, limit: filters.limit,
          offset: filters.offset, search: search.text)
      ).response
    }
    engines = Cached(lifetime: lifetime, invalidationWindowMs: invalidationWindowMs) {
      try await browseEngines(wire)
    }
    entityTypes = Cached(
      lifetime: lifetime, kept: book.map { KeptValue(book: $0, key: .entityTypes) },
      invalidationWindowMs: invalidationWindowMs
    ) {
      try await wire.request(Operations.browseEntityTypesRequested, BrowseEntityTypesRequest())
        .response.entityTypes
    }
    tagSchemas = Cached(
      lifetime: lifetime, kept: book.map { KeptValue(book: $0, key: .tagSchemas) },
      invalidationWindowMs: invalidationWindowMs
    ) {
      try await wire.request(Operations.browseTagSchemasRequested, BrowseTagSchemasRequest())
        .response.tagSchemas
    }
    resources = KeyedQueries(
      transport: transport, lifetime: lifetime, scope: \.self,
      kept: { key in book.map { KeptValue(book: $0, key: .resource(key)) } },
      invalidationWindowMs: invalidationWindowMs,
      fetch: { resource in
        try await wire.request(
          Operations.browseResourceRequested, BrowseResourceRequest(resourceId: resource)
        ).response.resource
      })
    events = KeyedQueries(
      transport: transport, lifetime: lifetime, scope: \.self,
      invalidationWindowMs: invalidationWindowMs
    ) { resource in
      try await wire.request(
        Operations.browseEventsRequested, BrowseEventsRequest(resourceId: resource)
      ).response.events
    }
    referencedBy = KeyedQueries(
      transport: transport, lifetime: lifetime, scope: \.self,
      invalidationWindowMs: invalidationWindowMs
    ) {
      resource in
      try await wire.request(
        Operations.gatherReferencedByRequested, GatherReferencedByRequest(resourceId: resource)
      ).response.referencedBy
    }
    annotations = KeyedQueries(
      transport: transport, lifetime: lifetime, scope: \.self,
      kept: { key in book.map { KeptValue(book: $0, key: .annotations(key)) } },
      invalidationWindowMs: invalidationWindowMs,
      fetch: { resource in
        guard let content else {
          throw TransportError(.error, "No content transport is configured")
        }
        return try await content.getAnnotations(resource).annotations
      })
    details = KeyedQueries(
      transport: transport, lifetime: lifetime, scope: \.resource,
      kept: { key in
        book.map { KeptValue(book: $0, key: .annotation(key.resource, key.annotation)) }
      },
      invalidationWindowMs: invalidationWindowMs,
      fetch: { key in
        try await wire.request(
          Operations.browseAnnotationRequested,
          BrowseAnnotationRequest(annotationId: key.annotation, resourceId: key.resource)
        ).response.annotation
      })
    for key in book?.keys ?? [] {
      switch key {
      case .resource(let resource): _ = resources.query(resource)
      case .annotations(let resource): _ = annotations.query(resource)
      case .annotation(let resource, let id):
        _ = details.query(AnnotationKey(resource: resource, annotation: id))
      case .entityTypes, .tagSchemas: break
      }
    }
  }

  func annotation(resourceId: ResourceId, annotationId: AnnotationId) -> Cached<Annotation> {
    details.query(AnnotationKey(resource: resourceId, annotation: annotationId))
  }

  func reopened() async {
    for rule in cacheRefresh where rule.on == "reopened" {
      await refresh(
        (rule.refetches ?? []).compactMap(Query.init(rawValue:)), subject: Subject(),
        coalescing: false)
    }
  }

  func receive(_ frame: ReceivedFrame) async {
    let rules = cacheRefresh.filter { rule in
      rule.on == frame.channel
        && ((rule.refetches ?? []) + (rule.writes ?? []) + (rule.removes ?? [])).contains {
          Query(rawValue: $0) != nil
        }
    }
    guard !rules.isEmpty else { return }
    do {
      let subject = try subject(of: frame)
      for rule in rules where rule.when == subject.condition {
        for query in (rule.writes ?? []).compactMap(Query.init(rawValue:)) {
          await write(query, subject: subject)
        }
        if (rule.removes ?? []).contains(Query.annotation.rawValue), let id = subject.annotation {
          let error = BusRequestError(.busNotFound, "Annotation \(id.value) was removed")
          for detail in annotationEntries(subject) { await detail.removeIfKnown(error) }
        }
        await refresh(
          (rule.refetches ?? []).compactMap(Query.init(rawValue:)),
          subject: rule.reach == "held" ? Subject() : subject, coalescing: true)
      }
    } catch {
      // A malformed event cannot identify what changed. Recheck the known entries.
      await refresh(Query.allCases, subject: Subject(), coalescing: true)
    }
  }

  private func subject(of frame: ReceivedFrame) throws -> Subject {
    let encoder = JSONEncoder()
    let decoder = JSONDecoder()
    let data = try encoder.encode(frame.payload)
    switch frame.channel {
    case Channels.busResumeGap.name:
      return Subject(resource: try decoder.decode(BusResumeGap.self, from: data).scope)
    case Channels.markDeleteOk.name:
      return Subject(
        annotation: try decoder.decode(MarkDeleteOk.self, from: data).response.annotationId)
    case Channels.markBodyUpdated.name:
      let event = try decoder.decode(EnrichedResourceEvent.self, from: data)
      if let annotation = event.annotation {
        return Subject(
          resource: event.resourceId, annotation: annotation.id, value: annotation,
          condition: "enriched")
      }
      let update = try decoder.decode(
        AnnotationBodyUpdatedPayload.self, from: encoder.encode(event.payload))
      return Subject(
        resource: event.resourceId, annotation: update.annotationId, condition: "unenriched")
    case Channels.markRemoved.name:
      let event = try decoder.decode(StoredEventResponse.self, from: data)
      let removal = try decoder.decode(
        AnnotationRemovedPayload.self, from: encoder.encode(event.payload))
      return Subject(resource: event.resourceId, annotation: removal.annotationId)
    default:
      return Subject(resource: try decoder.decode(StoredEventResponse.self, from: data).resourceId)
    }
  }

  private func annotationEntries(_ subject: Subject) -> [Cached<Annotation>] {
    if let resource = subject.resource, let annotation = subject.annotation {
      return details.existing(AnnotationKey(resource: resource, annotation: annotation)).map {
        [$0]
      } ?? []
    }
    return details.matching { key in
      (subject.resource == nil || subject.resource == key.resource)
        && (subject.annotation == nil || subject.annotation == key.annotation)
    }
  }

  private func write(_ query: Query, subject: Subject) async {
    guard let value = subject.value else { return }
    switch query {
    case .annotation:
      for detail in annotationEntries(subject) { await detail.writeIfKnown(value) }
    case .annotations:
      guard let resource = subject.resource else { return }
      await annotations.existing(resource)?.editIfKnown { current in
        var current = current
        if let index = current.firstIndex(where: { $0.id == value.id }) {
          current[index] = value
        } else {
          current.append(value)
        }
        return current
      }
    default: break
    }
  }

  private func refresh(_ queries: [Query], subject: Subject, coalescing: Bool) async {
    for query in queries {
      switch query {
      case .resources: await listedResources.refresh(nil, coalescing: coalescing)
      case .matchedResources: await matchedResources.refresh(nil, coalescing: coalescing)
      case .engines: await engines.refreshIfKnown(coalescing: coalescing)
      case .entityTypes: await entityTypes.refreshIfKnown(coalescing: coalescing)
      case .tagSchemas: await tagSchemas.refreshIfKnown(coalescing: coalescing)
      case .resource: await resources.refresh(subject.resource, coalescing: coalescing)
      case .events: await events.refresh(subject.resource, coalescing: coalescing)
      case .referencedBy: await referencedBy.refresh(subject.resource, coalescing: coalescing)
      case .annotations: await annotations.refresh(subject.resource, coalescing: coalescing)
      case .annotation:
        for detail in annotationEntries(subject) {
          await detail.refreshIfKnown(coalescing: coalescing)
        }
      }
    }
  }
}
