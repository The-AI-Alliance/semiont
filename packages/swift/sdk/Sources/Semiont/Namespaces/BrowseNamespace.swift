public struct BrowseNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  let lifetime: Lifetime

  public func resourceEvents(_ resourceId: ResourceId) async throws -> [AttributedEvent] {
    try await wire.request(
      Operations.browseEventsRequested, BrowseEventsRequest(resourceId: resourceId)
    ).response.events
  }
  public func annotationHistory(resourceId: ResourceId, annotationId: AnnotationId) async throws
    -> GetAnnotationHistoryResponse
  {
    try await wire.request(
      Operations.browseAnnotationHistoryRequested,
      BrowseAnnotationHistoryRequest(annotationId: annotationId, resourceId: resourceId)
    ).response
  }
  public func files(_ dirPath: String = ".", sort: BrowseDirectoryRequestSort = .name)
    async throws -> BrowseDirectoryResultResponse
  {
    try await wire.request(
      Operations.browseDirectoryRequested, BrowseDirectoryRequest(path: dirPath, sort: sort)
    ).response
  }
  public func kb() async throws -> KbDescription {
    try await wire.request(Operations.browseKbRequested, BrowseKbRequest()).response
  }
  public func click(_ annotationId: AnnotationId) throws {
    try bus.emit(Channels.browseClick, BrowseClickEvent(annotationId: annotationId))
  }
  public func openResource(_ resourceId: ResourceId) throws {
    try bus.emit(Channels.browseResourceOpen, BrowseResourceOpenEvent(resourceId: resourceId))
  }
  public func resourceViewed(_ resourceId: ResourceId) {
    lifetime.start {
      _ = try? await wire.emit(
        Channels.browseResourceViewed, BrowseResourceViewedEvent(resourceId: resourceId))
    }
  }
}
