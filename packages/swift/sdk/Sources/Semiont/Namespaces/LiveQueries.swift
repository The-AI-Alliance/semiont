import Foundation
import Synchronization

final class ScopedQueries<Key: Hashable & Sendable, Value: Sendable>: Sendable {
  private let entries = Mutex<[Key: Cached<Value>]>([:])
  private let transport: any Transport
  private let lifetime: Lifetime
  private let scope: @Sendable (Key) -> ResourceId
  private let fetch: @Sendable (Key) async throws -> Value

  init(
    transport: any Transport, lifetime: Lifetime, scope: @escaping @Sendable (Key) -> ResourceId,
    fetch: @escaping @Sendable (Key) async throws -> Value
  ) {
    self.transport = transport
    self.lifetime = lifetime
    self.scope = scope
    self.fetch = fetch
    lifetime.onEnd { [weak self] in
      self?.entries.withLock { $0.removeAll() }
    }
  }

  func query(_ key: Key) -> Cached<Value> {
    let transport = transport
    let fetch = fetch
    let resource = scope(key)
    return entries.withLock { entries in
      if let query = entries[key] { return query }
      let query = Cached(
        lifetime: lifetime, hold: { await transport.subscribeToResource(resource) }
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
  let resources: ScopedQueries<ResourceId, ResourceDescriptor>
  let events: ScopedQueries<ResourceId, [AttributedEvent]>
  let referencedBy: ScopedQueries<ResourceId, [GetReferencedByResponseReferencedByItem]>
  let annotations: ScopedQueries<ResourceId, [Annotation]>
  private let details: ScopedQueries<AnnotationKey, Annotation>

  init(wire: Bus, transport: any Transport, content: (any ContentTransport)?, lifetime: Lifetime) {
    entityTypes = Cached(lifetime: lifetime) {
      try await wire.request(Operations.browseEntityTypesRequested, BrowseEntityTypesRequest())
        .response.entityTypes
    }
    tagSchemas = Cached(lifetime: lifetime) {
      try await wire.request(Operations.browseTagSchemasRequested, BrowseTagSchemasRequest())
        .response.tagSchemas
    }
    resources = ScopedQueries(transport: transport, lifetime: lifetime, scope: \.self) { resource in
      try await wire.request(
        Operations.browseResourceRequested, BrowseResourceRequest(resourceId: resource)
      ).response.resource
    }
    events = ScopedQueries(transport: transport, lifetime: lifetime, scope: \.self) { resource in
      try await wire.request(
        Operations.browseEventsRequested, BrowseEventsRequest(resourceId: resource)
      ).response.events
    }
    referencedBy = ScopedQueries(transport: transport, lifetime: lifetime, scope: \.self) {
      resource in
      try await wire.request(
        Operations.gatherReferencedByRequested, GatherReferencedByRequest(resourceId: resource)
      ).response.referencedBy
    }
    annotations = ScopedQueries(transport: transport, lifetime: lifetime, scope: \.self) {
      resource in
      guard let content else { throw TransportError(.error, "No content transport is configured") }
      return try await content.getAnnotations(resource).annotations
    }
    details = ScopedQueries(transport: transport, lifetime: lifetime, scope: \.resource) {
      key in
      try await wire.request(
        Operations.browseAnnotationRequested,
        BrowseAnnotationRequest(annotationId: key.annotation, resourceId: key.resource)
      ).response.annotation
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
