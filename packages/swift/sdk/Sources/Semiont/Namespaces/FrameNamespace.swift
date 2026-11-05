public struct FrameNamespace: Sendable {
  let wire: Bus
  public func addEntityType(_ type: String) async throws {
    _ = try await wire.request(Operations.frameAddEntityType, FrameAddEntityTypeCommand(tag: type))
  }
  public func addEntityTypes(_ types: [String]) async throws {
    for type in types { try await addEntityType(type) }
  }
  public func addTagSchema(_ schema: TagSchema) async throws {
    _ = try await wire.request(
      Operations.frameAddTagSchema, FrameAddTagSchemaCommand(schema: schema))
  }
}
