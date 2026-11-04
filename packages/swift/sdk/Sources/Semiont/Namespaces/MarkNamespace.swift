public struct MarkNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  let lifetime: Lifetime
  let timing: FollowTiming
  public func annotation(_ request: CreateAnnotationRequest) async throws -> MarkCreateOkResponse {
    try await wire.request(
      Operations.markCreateRequest,
      MarkCreateRequest(request: request, resourceId: request.target.source)
    ).response
  }
  public func delete(resourceId: ResourceId, annotationId: AnnotationId) async throws {
    _ = try await wire.request(
      Operations.markDelete, MarkDeleteCommand(annotationId: annotationId, resourceId: resourceId))
  }
  public func archive(_ resourceId: ResourceId) async throws {
    _ = try await wire.request(Operations.markArchive, MarkArchiveCommand(resourceId: resourceId))
  }
  public func unarchive(_ resourceId: ResourceId) async throws {
    _ = try await wire.request(
      Operations.markUnarchive, MarkUnarchiveCommand(resourceId: resourceId))
  }
  public func updateEntityTypes(resourceId: ResourceId, current: [String], updated: [String])
    async throws
  {
    _ = try await wire.request(
      Operations.markUpdateEntityTypes,
      MarkUpdateEntityTypesCommand(
        currentEntityTypes: current, resourceId: resourceId, updatedEntityTypes: updated))
  }
  public func delegate(resourceId: ResourceId, params: MarkJobParams) -> Delegation<
    MarkJobCompleteCommand
  > {
    follow(
      create: .markJobCreateCommand(MarkJobCreateCommand(params: params, resourceId: resourceId)),
      resource: resourceId, wire: wire, bus: bus, lifetime: lifetime, timing: timing,
      completion: MarkJobCompleteCommand.self)
  }
  public func request(source: ResourceId, selector: AnnotationSelector, motivation: Motivation)
    throws
  {
    try bus.emit(
      Channels.markRequested,
      MarkRequestedEvent(motivation: motivation, selector: selector, source: source))
  }
  public func submit(_ input: MarkSubmitEvent) throws { try bus.emit(Channels.markSubmit, input) }
  public func reportDeleteError(_ input: ResourceErrorEvent) throws {
    try bus.emit(Channels.markDeleteError, input)
  }
}
