public struct BindNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  public func body(
    resourceId: ResourceId, annotationId: AnnotationId, operations: [BindBodyOperation]
  ) async throws {
    _ = try await wire.request(
      Operations.bindUpdateBody,
      BindUpdateBodyCommand(
        annotationId: annotationId, operations: operations, resourceId: resourceId))
  }
  public func initiate(_ input: BindInitiateCommand) throws {
    try bus.emit(Channels.bindInitiate, input)
  }
  public func reportBodyError(_ input: ResourceErrorEvent) throws {
    try bus.emit(Channels.bindBodyError, input)
  }
}
