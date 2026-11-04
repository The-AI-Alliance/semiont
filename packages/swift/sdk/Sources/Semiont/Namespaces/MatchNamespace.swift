public struct MatchNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  let lifetime: Lifetime
  let live: LiveQueries

  public func resources(
    _ search: String, filters: ResourceFilters = ResourceFilters()
  ) -> Cached<MatchResourcesResponse> {
    live.matchedResources.observe(LiveQueries.SearchKey(text: search, filters: filters))
  }
  public func search(
    resourceId: ResourceId, referenceId: AnnotationId, context: GatheredContext, limit: Int = 10,
    useSemanticScoring: Bool = true
  ) -> Running<MatchSearchResult> {
    let request = MatchSearchRequest(
      context: context, limit: limit, referenceId: referenceId, resourceId: resourceId,
      useSemanticScoring: useSemanticScoring)
    return search(request)
  }

  func search(_ request: MatchSearchRequest) -> Running<MatchSearchResult> {
    var request = request
    if request.limit == nil { request.limit = 10 }
    if request.useSemanticScoring == nil { request.useSemanticScoring = true }
    return Running(lifetime: lifetime) { [request] _ in
      try await wire.request(Operations.matchSearchRequested, request)
    }
  }
  public func requestSearch(_ input: MatchSearchRequest, correlationId: String) throws {
    try bus.emit(Channels.matchSearchRequested, input, correlationId: correlationId)
  }
}
