public struct SystemNamespace: Sendable {
  let gateway: any GatewayOperations
  public func healthCheck() async throws -> HealthResponse { try await gateway.healthCheck() }
  public func status() async throws -> StatusResponse { try await gateway.getStatus() }
}
