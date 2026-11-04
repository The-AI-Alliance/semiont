// README examples begin
import AsyncHTTPClient
import Semiont

func connect(
  to gateway: String, token: String?, using http: HTTPClient
) async throws -> SemiontClient {
  try await SemiontClient.fromHttp(baseUrl: gateway, httpClient: http, token: token)
}

func generate(
  from resource: ResourceId, using client: SemiontClient
) async throws -> YieldJobCompleteCommand {
  let context = try await client.gather.resource(resource)
  let run = try client.yield.delegate(
    params: GenerationJobParams(
      context: context, storageUri: "file://summary.md", title: "Summary"))
  return try await run.completed()
}

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
