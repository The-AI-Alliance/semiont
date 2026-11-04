public struct BrowseNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  let lifetime: Lifetime
  let content: (any ContentTransport)?
  let live: LiveQueries

  public func entityTypes() -> Cached<[String]> { live.entityTypes }
  public func tagSchemas() -> Cached<[TagSchema]> { live.tagSchemas }

  public func resource(_ resourceId: ResourceId) -> Cached<ResourceDescriptor> {
    live.resources.query(resourceId)
  }
  public func events(_ resourceId: ResourceId) -> Cached<[AttributedEvent]> {
    live.events.query(resourceId)
  }

  public func annotations(_ resourceId: ResourceId) -> Cached<[Annotation]> {
    live.annotations.query(resourceId)
  }
  public func annotation(resourceId: ResourceId, annotationId: AnnotationId) -> Cached<Annotation> {
    live.annotation(resourceId: resourceId, annotationId: annotationId)
  }

  private var contentTransport: any ContentTransport {
    get throws {
      guard let content else { throw TransportError(.error, "No content transport is configured") }
      return content
    }
  }
  public func resourceContent(_ resourceId: ResourceId) async throws -> String {
    let representation = try await resourceRepresentation(resourceId)
    return try decodeRepresentation(representation.bytes, contentType: representation.contentType)
  }
  public func resourceGraph(_ resourceId: ResourceId) async throws -> GetResourceResponse {
    try await contentTransport.getResourceGraph(resourceId)
  }
  public func resourceAnchoredText(_ resourceId: ResourceId) async throws -> AnchoredTextAnswer {
    try await contentTransport.getAnchoredText(resourceId)
  }
  public func resourceRepresentation(_ resourceId: ResourceId) async throws -> Content {
    try await contentTransport.getBinary(resourceId)
  }
  public func resourceRepresentationStream(_ resourceId: ResourceId) async throws -> ContentStream {
    try await contentTransport.getBinaryStream(resourceId)
  }

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
