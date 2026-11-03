public struct GatherNamespace: Sendable {
  let wire: Bus
  let lifetime: Lifetime
  public func annotation(
    resourceId: ResourceId, annotationId: AnnotationId, options: GatherAnnotationOptions? = nil
  ) -> Running<GatherAnnotationComplete> {
    var options = options ?? GatherAnnotationOptions()
    if options.contextWindow == nil { options.contextWindow = 2000 }
    let request = GatherAnnotationRequest(
      annotationId: annotationId, options: options, resourceId: resourceId)
    return Running(lifetime: lifetime) { _ in
      try await wire.request(Operations.gatherRequested, request)
    }
  }
  public func resource(_ resourceId: ResourceId, options: GatherResourceOptions? = nil) async throws
    -> GatheredContext
  {
    let excluded = options?.excludeEntityTypes.flatMap { $0.isEmpty ? nil : $0 }
    let options = GatherResourceRequestOptions(
      depth: options?.depth ?? 2, excludeEntityTypes: excluded,
      includeContent: options?.includeContent ?? true,
      includeSummary: options?.includeSummary ?? false,
      maxResources: options?.maxResources ?? 10)
    return try await wire.request(
      Operations.gatherResourceRequested,
      GatherResourceRequest(options: options, resourceId: resourceId)
    ).response
  }
}
