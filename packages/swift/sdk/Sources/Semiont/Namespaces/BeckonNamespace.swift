public struct BeckonNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  public func attention(resourceId: ResourceId, annotationId: AnnotationId? = nil) async throws
    -> Int?
  {
    try await wire.emit(
      Channels.beckonFocus, BeckonFocusEvent(annotationId: annotationId, resourceId: resourceId))
  }
  public func click(_ annotationId: AnnotationId) async throws -> Int? {
    try await wire.emit(Channels.browseClick, BrowseClickEvent(annotationId: annotationId))
  }
  public func openResource(_ resourceId: ResourceId) async throws -> Int? {
    try await wire.emit(
      Channels.browseResourceOpen, BrowseResourceOpenEvent(resourceId: resourceId))
  }
  public func sparkleAll(_ annotationId: AnnotationId) async throws -> Int? {
    try await wire.emit(Channels.beckonSparkle, BeckonSparkleEvent(annotationId: annotationId))
  }
  public func hover(_ annotationId: AnnotationId?) throws {
    try bus.emit(Channels.beckonHover, BeckonHoverEvent(annotationId: annotationId))
  }
  public func sparkle(_ annotationId: AnnotationId) throws {
    try bus.emit(Channels.beckonSparkle, BeckonSparkleEvent(annotationId: annotationId))
  }
}
