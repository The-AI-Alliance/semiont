public struct AuthNamespace: Sendable {
  let gateway: any GatewayOperations
  public func me() async throws -> UserResponse { try await gateway.getCurrentUser() }
  public func mediaToken(_ resourceId: ResourceId) async throws -> MediaTokenResponse {
    try await gateway.getMediaToken(resourceId)
  }
  public func protectedResourceMetadata() async throws -> ProtectedResourceMetadata {
    try await gateway.getProtectedResourceMetadata()
  }
}
