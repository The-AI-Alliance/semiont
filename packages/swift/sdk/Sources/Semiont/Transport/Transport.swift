/// The ordered wire a client uses, independent of how it reaches a knowledge base.
public protocol Transport: Sendable {
  var baseUrl: String { get }
  var state: Watched<ConnectionState> { get }
  /// An empty channel list listens to every frame this transport delivers.
  func frames(_ channels: [String]) async throws -> Events<ReceivedFrame>
  func subscribeToResource(_ resource: ResourceId) async -> ResourceHold
  func emit(
    channel: String, payload: [String: JSONValue], scope: ResourceId?, correlationId: String?
  ) async throws -> Int?
  func request(operation: String, payload: [String: JSONValue], timeoutMs: Int?) async throws
    -> [String: JSONValue]
  func failures() -> Events<TransportError>
  func dispose()
}
public protocol GatewayOperations: Sendable {
  func getCurrentUser() async throws -> UserResponse
  func getMediaToken(_ resource: ResourceId) async throws -> MediaTokenResponse
  func getProtectedResourceMetadata() async throws -> ProtectedResourceMetadata
  func healthCheck() async throws -> HealthResponse
  func getStatus() async throws -> StatusResponse
}

public protocol ContentTransport: Sendable {
  func getBinary(_ resource: ResourceId) async throws -> Content
  func getBinaryStream(_ resource: ResourceId) async throws -> ContentStream
  func getResourceGraph(_ resource: ResourceId) async throws -> GetResourceResponse
  func getAnchoredText(_ resource: ResourceId) async throws -> AnchoredTextAnswer
  func putBinary(_ request: PutBinaryRequest) -> Upload
}
