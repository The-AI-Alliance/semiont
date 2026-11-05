// README examples begin
import AsyncHTTPClient
import Semiont

func readFirstResource(
  _ resource: ResourceId, in kb: KbTarget,
  showCode: @Sendable (DeviceCode) -> Void
) async throws -> ResourceDescriptor {
  let http = HTTPClient(eventLoopGroupProvider: .singleton)
  let kept = MemorySignIn()
  let descriptor: ResourceDescriptor
  do {
    try await signInDevice(kb: kb, kept: kept, httpClient: http, onCode: showCode)
    let opened = try await sessionFromKept(kb: kb, kept: kept, httpClient: http)
    defer { opened.dispose() }
    try await opened.session.ready()
    descriptor = try await opened.client.browse.resource(resource).fresh()
  } catch {
    try? await http.shutdown()
    throw error
  }
  try await http.shutdown()
  return descriptor
}
// README examples end

// README examples begin
func generate(
  from resource: ResourceId, using client: SemiontClient
) async throws -> YieldJobCompleteCommand {
  let context = try await client.gather.resource(resource)
  let run = try client.yield.delegate(
    params: GenerationJobParams(
      context: context, storageUri: "file://summary.md", title: "Summary"))
  return try await run.completed()
}
// README examples end

// README examples begin
func watchResource(
  _ resource: ResourceId, using client: SemiontClient,
  show: (CacheState<ResourceDescriptor>) -> Void
) async {
  for await state in client.browse.resource(resource) {
    switch state {
    case .pending: show(.pending)
    case .ready(let resource): show(.ready(resource))
    case .failed(let error): show(.failed(error))
    }
  }
}
// README examples end
