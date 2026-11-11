import Foundation
import Synchronization

struct LiveQueries: Sendable {
  struct SearchKey: Hashable, Sendable {
    let text: String
    let filters: ResourceFilters
  }

  struct AnnotationKey: Hashable, Sendable {
    let resource: ResourceId
    let annotation: AnnotationId
  }

  /// What an event names by its row's ways: the keys a `subject` row reaches, and the annotation
  /// it carries.
  private struct Subject {
    var resource: ResourceId?
    var annotation: AnnotationId?
    var written: Annotation?
  }

  let entityTypes: Cached<KeptEntityTypes>
  let tagSchemas: Cached<KeptTagSchemas>
  let resources: Cache<ResourceId, KeptResource>
  let events: Cache<ResourceId, [AttributedEvent]>
  let referencedBy: Cache<ResourceId, [GetReferencedByResponseReferencedByItem]>
  let annotations: Cache<ResourceId, KeptAnnotations>
  let listedResources: Cache<ResourceFilters, ListResourcesResponse>
  let matchedResources: Cache<SearchKey, MatchResourcesResponse>
  let engines: Cached<[EngineEntry]>
  /// The engines, each joined with the limits reported for it: the one view every observer of the
  /// engines shares (B4).
  let enginesWithLimits: Cached<[EngineWithLimits]>
  let details: Cache<AnnotationKey, KeptAnnotation>
  private let annotationLists = Views<ResourceId, [Annotation]>()
  private let keeping: KeptQueries?

  init(
    wire: Bus, transport: any Transport, content: (any ContentTransport)?, lifetime: Lifetime,
    keeping: KeptQueries?, invalidationWindowMs: Int, clock: any Clock<Duration>
  ) {
    self.keeping = keeping
    let owed = keeping?.underway
    listedResources = Cache(
      lifetime: lifetime, owed: owed, invalidationWindowMs: invalidationWindowMs, clock: clock
    ) { filters in
      try await wire.request(
        Operations.browseResourcesRequested,
        BrowseResourcesRequest(
          archived: filters.archived, entityType: filters.entityType, limit: filters.limit,
          offset: filters.offset)
      ).response
    }
    matchedResources = Cache(
      lifetime: lifetime, owed: owed, invalidationWindowMs: invalidationWindowMs, clock: clock
    ) { search in
      let filters = search.filters
      return try await wire.request(
        Operations.matchResourcesRequested,
        MatchResourcesRequest(
          archived: filters.archived, entityType: filters.entityType, limit: filters.limit,
          offset: filters.offset, search: search.text)
      ).response
    }
    let limits = ReportedLimits()
    let engines = Cached(
      lifetime: lifetime, owed: owed, invalidationWindowMs: invalidationWindowMs, clock: clock
    ) {
      try await browseEngines(wire, keeping: limits)
    }
    self.engines = engines
    enginesWithLimits = engines.view { limits.joined($0) }
    entityTypes = Cached(
      lifetime: lifetime,
      kept: keeping.map { KeptValue(keeping: $0, query: .entityTypes, key: WholeKey()) },
      owed: owed, invalidationWindowMs: invalidationWindowMs, clock: clock
    ) {
      try await wire.request(Operations.browseEntityTypesRequested, BrowseEntityTypesRequest())
        .response.entityTypes
    }
    tagSchemas = Cached(
      lifetime: lifetime,
      kept: keeping.map { KeptValue(keeping: $0, query: .tagSchemas, key: WholeKey()) },
      owed: owed, invalidationWindowMs: invalidationWindowMs, clock: clock
    ) {
      try await wire.request(Operations.browseTagSchemasRequested, BrowseTagSchemasRequest())
        .response.tagSchemas
    }
    resources = Cache(
      lifetime: lifetime, hold: { await transport.subscribeToResource($0) },
      kept: { key in keeping.map { KeptValue(keeping: $0, query: .resource, key: key) } },
      owed: owed,
      invalidationWindowMs: invalidationWindowMs, clock: clock,
      fetch: { resource in
        try await wire.request(
          Operations.browseResourceRequested, BrowseResourceRequest(resourceId: resource)
        ).response.resource
      })
    events = Cache(
      lifetime: lifetime, hold: { await transport.subscribeToResource($0) }, owed: owed,
      invalidationWindowMs: invalidationWindowMs, clock: clock,
      fetch: { resource in
        try await wire.request(
          Operations.browseEventsRequested, BrowseEventsRequest(resourceId: resource)
        ).response.events
      })
    referencedBy = Cache(
      lifetime: lifetime, hold: { await transport.subscribeToResource($0) }, owed: owed,
      invalidationWindowMs: invalidationWindowMs, clock: clock,
      fetch: { resource in
        try await wire.request(
          Operations.gatherReferencedByRequested, GatherReferencedByRequest(resourceId: resource)
        ).response.referencedBy
      })
    annotations = Cache(
      lifetime: lifetime, hold: { await transport.subscribeToResource($0) },
      kept: { key in keeping.map { KeptValue(keeping: $0, query: .annotations, key: key) } },
      owed: owed,
      invalidationWindowMs: invalidationWindowMs, clock: clock,
      fetch: { resource in
        guard let content else {
          throw TransportError(.error, "No content transport is configured")
        }
        return try await content.getAnnotations(resource)
      })
    details = Cache(
      lifetime: lifetime, hold: { await transport.subscribeToResource($0.resource) },
      kept: { key in
        keeping.map { KeptValue(keeping: $0, query: .annotation, key: key.annotation) }
      },
      owed: owed, invalidationWindowMs: invalidationWindowMs, clock: clock,
      fetch: { key in
        try await wire.request(
          Operations.browseAnnotationRequested,
          BrowseAnnotationRequest(annotationId: key.annotation, resourceId: key.resource)
        ).response.annotation
      })
  }

  /// B17, as the client starts keeping: each persisted query takes what is kept for a key it holds
  /// no value for, and what is kept is made to agree with every other key it holds, owing no save,
  /// so the save of its next change writes the whole document. A kept annotation is of the
  /// resource its target is.
  func rehydrate() async {
    guard let keeping else { return }
    for query in KeptQuery.allCases {
      switch query {
      case .resource:
        let held = await resources.keys()
        for key in Set(keeping.keys(query, as: ResourceId.self)).union(held) {
          await resources.observe(key).keepingStarted { keeping.absorb(query, key, $0) }
        }
      case .annotations:
        let held = await annotations.keys()
        for key in Set(keeping.keys(query, as: ResourceId.self)).union(held) {
          await annotations.observe(key).keepingStarted { keeping.absorb(query, key, $0) }
        }
      case .annotation:
        var keys = Set(await details.keys())
        for id in keeping.keys(query, as: AnnotationId.self) {
          guard let annotation = keeping.load(query, id, as: KeptAnnotation.self) else { continue }
          keys.insert(AnnotationKey(resource: targetSource(annotation.target), annotation: id))
        }
        for key in keys {
          await details.observe(key).keepingStarted { keeping.absorb(query, key.annotation, $0) }
        }
      case .entityTypes:
        await entityTypes.keepingStarted { keeping.absorb(query, WholeKey(), $0) }
      case .tagSchemas:
        await tagSchemas.keepingStarted { keeping.absorb(query, WholeKey(), $0) }
      }
    }
  }

  func annotationList(_ resource: ResourceId) -> Cached<[Annotation]> {
    annotationLists.view(resource) { annotations.observe(resource).view { $0.annotations } }
  }

  func annotation(resourceId: ResourceId, annotationId: AnnotationId) -> Cached<Annotation> {
    details.observe(AnnotationKey(resource: resourceId, annotation: annotationId))
  }

  func reopened() async {
    await apply(refreshRow(.reopened, nil), to: Subject(), coalescing: false)
  }

  /// A frame on one of the refresh table's channels: its row, or, when it is unreadable, the row
  /// of an unreadable event, which names nothing.
  func receive(_ carried: Carried) async {
    guard let trigger = CacheRefreshTrigger(rawValue: carried.channel),
      let stamps = cacheRefreshChannels[trigger]
    else { return }
    do throws(Unreadable) {
      let (row, subject) = try reading(carried, on: trigger, stamps: stamps)
      await apply(row, to: subject, coalescing: true)
    } catch {
      await apply(refreshRow(.unreadable, nil), to: Subject(), coalescing: true)
    }
  }

  /// The row `carried` applies, and what it names by the row's ways. A frame refused, by the
  /// transport or by its channel's reading, is unreadable. A split channel's event is enriched
  /// when the member its enriched row carries is present, read there as an Annotation.
  private func reading(_ carried: Carried, on trigger: CacheRefreshTrigger, stamps: Set<String>)
    throws(Unreadable) -> (CacheRefreshRow, Subject)
  {
    guard case .frame(let frame) = carried else { throw Unreadable() }
    guard let read = try? payloadAsRead(declared(frame.payload, stamps: stamps), on: frame.channel)
    else { throw Unreadable() }
    let payload = JSONValue.object(read)
    let row: CacheRefreshRow
    if let enriched = cacheRefresh.first(where: { $0.on == trigger && $0.when == .enriched }) {
      let written = try member(enriched.carries, of: payload, as: Annotation.self)
      row = refreshRow(trigger, written == nil ? .unenriched : .enriched)
    } else {
      row = refreshRow(trigger, nil)
    }
    return try (
      row,
      Subject(
        resource: member(row.resource, of: payload, as: ResourceId.self),
        annotation: member(row.annotation, of: payload, as: AnnotationId.self),
        written: member(row.carries, of: payload, as: Annotation.self))
    )
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

  /// Apply `row` to what `subject` names: a `held` row reaches every key held.
  private func apply(_ row: CacheRefreshRow, to subject: Subject, coalescing: Bool) async {
    for query in row.writes { await write(query, subject: subject) }
    for query in row.removes { await remove(query, subject: subject) }
    let reached = row.reach == .held ? Subject() : subject
    for query in row.refetches { await refetch(query, subject: reached, coalescing: coalescing) }
  }

  private func write(_ query: CacheQuery, subject: Subject) async {
    guard let value = subject.written else { return }
    switch query {
    case .annotation:
      for detail in annotationEntries(subject) { await detail.writeIfKnown(value) }
    case .annotations:
      guard let resource = subject.resource else { return }
      await annotations.existing(resource)?.editIfKnown { current in
        var current = current
        if let index = current.annotations.firstIndex(where: { $0.id == value.id }) {
          current.annotations[index] = value
        } else {
          current.annotations.append(value)
        }
        return current
      }
    case .resource, .events, .referencedBy, .resources, .matchedResources, .entityTypes,
      .tagSchemas, .engines:
      preconditionFailure("The refresh table writes \(query.rawValue), which no event carries")
    }
  }

  private func remove(_ query: CacheQuery, subject: Subject) async {
    switch query {
    case .annotation:
      guard let id = subject.annotation else { return }
      let error = BusRequestError(.busNotFound, "Annotation \(id.value) was removed")
      for detail in annotationEntries(subject) { await detail.removeIfKnown(error) }
    case .resource, .annotations, .events, .referencedBy, .resources, .matchedResources,
      .entityTypes, .tagSchemas, .engines:
      preconditionFailure(
        "The refresh table removes \(query.rawValue), which no event reports gone")
    }
  }

  private func refetch(_ query: CacheQuery, subject: Subject, coalescing: Bool) async {
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

/// One view of a query per key, so every observer of a key shares one (B4).
private final class Views<Key: Hashable & Sendable, Value: Sendable>: Sendable {
  private let held = Mutex<[Key: Cached<Value>]>([:])

  func view(_ key: Key, _ make: () -> Cached<Value>) -> Cached<Value> {
    held.withLock { held in
      if let view = held[key] { return view }
      let view = make()
      held[key] = view
      return view
    }
  }
}

/// An event a member of which its row names is present and is not what it names, or a frame
/// its channel's reading refuses.
private struct Unreadable: Error {}

/// The refresh table's one row for `trigger` of kind `when`.
private func refreshRow(_ trigger: CacheRefreshTrigger, _ when: CacheRefreshWhen?)
  -> CacheRefreshRow
{
  guard let row = cacheRefresh.first(where: { $0.on == trigger && $0.when == when }) else {
    preconditionFailure("The refresh table has no row for \(trigger.rawValue)")
  }
  return row
}

/// The member `way` ends at in `payload`, decoded as `Value`: nil where there is no way, or the
/// member or one it is within is absent or null. One it is within that is present and no object,
/// or the member itself present and not a `Value`, makes the event unreadable.
private func member<Value: Decodable>(_ way: [String]?, of payload: JSONValue, as type: Value.Type)
  throws(Unreadable) -> Value?
{
  guard let way else { return nil }
  var member = payload
  for name in way {
    switch member {
    case .null: return nil
    case .object(let fields):
      guard let next = fields[name] else { return nil }
      member = next
    case .bool, .number, .string, .array: throw Unreadable()
    }
  }
  if member == .null { return nil }
  do {
    return try JSONDecoder().decode(type, from: JSONEncoder().encode(member))
  } catch {
    throw Unreadable()
  }
}
