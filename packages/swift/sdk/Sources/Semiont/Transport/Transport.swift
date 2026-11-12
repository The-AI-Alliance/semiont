/// The ordered wire a client uses, independent of how it reaches a knowledge base.
public protocol Transport: Sendable {
  var baseUrl: String { get }
  var state: Watched<ConnectionState> { get }
  /// What this transport delivers on `channels`: each frame, or a frame's refusal in its place. An
  /// empty channel list listens to everything it delivers.
  func frames(_ channels: [String]) async throws -> Events<Carried>
  func subscribeToResource(_ resource: ResourceId) async -> ResourceHold
  func emit(
    channel: String, payload: [String: JSONValue], scope: ResourceId?, correlationId: String?
  ) async throws -> Int?
  /// The reply to the request of `operation`: its result's payload, or its failure as the error.
  /// It keeps no deadline: the bus that asks keeps the request's, and gives the request up by
  /// cancelling its task, which ends it.
  func request(operation: String, payload: [String: JSONValue]) async throws -> [String: JSONValue]
  /// Tells `listener` each failure the transport meets (everything a server refused, every request
  /// the gateway never answered, and every line its stream carried that names no reader) within
  /// the telling: before the call that met it returns, so in the order they were met. Taken first,
  /// it is told at once the latest `Timings.errorsKeptForFirstReaderCount` met before it came, in
  /// order; taken later, those met from then on. It is held until the transport is disposed, and
  /// one taken after that is told nothing. It must not wait, nor call back into the transport's
  /// failures.
  func tellFailures(to listener: @escaping @Sendable (TransportError) -> Void)
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
  func getAnnotations(_ resource: ResourceId) async throws -> GetAnnotationsResponse
  func getResourceGraph(_ resource: ResourceId) async throws -> GetResourceResponse
  func getAnchoredText(_ resource: ResourceId) async throws -> AnchoredTextAnswer
  func putBinary(_ request: PutBinaryRequest) -> Upload
}
