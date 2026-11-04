public struct MatchNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  let lifetime: Lifetime
  let live: LiveQueries

  public func resources(
    _ search: String, filters: ResourceFilters = ResourceFilters()
  ) -> Cached<MatchResourcesResponse> {
    live.matchedResources.query(LiveQueries.SearchKey(text: search, filters: filters))
  }
  public func search(
    resourceId: ResourceId, referenceId: AnnotationId, context: GatheredContext, limit: Int = 10,
    useSemanticScoring: Bool = true
  ) -> Running<MatchSearchResult> {
    let request = MatchSearchRequest(
      context: context, limit: limit, referenceId: referenceId, resourceId: resourceId,
      useSemanticScoring: useSemanticScoring)
    return Running(lifetime: lifetime) { _ in
      try await wire.request(Operations.matchSearchRequested, request)
    }
  }
  public func requestSearch(_ input: MatchSearchRequest, correlationId: String) throws {
    try bus.emit(Channels.matchSearchRequested, input, correlationId: correlationId)
  }
}
