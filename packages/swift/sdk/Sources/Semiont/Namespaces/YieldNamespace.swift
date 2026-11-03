import Foundation

public struct YieldNamespace: Sendable {
  let wire: Bus
  let bus: EventBus
  let lifetime: Lifetime
  let timing: FollowTiming
  public func delegate(params: GenerationJobParams, stallDeadlineMs: Int? = nil) throws
    -> Delegation<YieldJobCompleteCommand>
  {
    let resource: ResourceId
    switch params.context.focus {
    case .resource(let focus): resource = focus.resource.id
    case .annotation(let focus): resource = focus.sourceResource.id
    }
    let stall = try stallDeadlineMs ?? generationStallDeadline(maxTokens: params.maxTokens)
    return follow(
      create: .yieldJobCreateCommand(YieldJobCreateCommand(params: params)), resource: resource,
      wire: wire, bus: bus, lifetime: lifetime, timing: timing, stallMs: stall,
      completion: YieldJobCompleteCommand.self)
  }
  public func cloneToken(_ resourceId: ResourceId) async throws -> CloneResourceWithTokenResponse {
    try await wire.request(
      Operations.yieldCloneTokenRequested, YieldCloneTokenRequest(resourceId: resourceId)
    ).response
  }
  public func fromToken(_ token: String) async throws -> ResourceDescriptor {
    try await wire.request(
      Operations.yieldCloneResourceRequested, YieldCloneResourceRequest(token: token)
    ).response.sourceResource
  }
  public func clone() throws { try bus.emit(Channels.yieldClone, BusEmptyPayload()) }
}
func generationStallDeadline(maxTokens: Double?) throws -> Int {
  let tokens = max(0, maxTokens ?? Double(Timings.generationStallAssumedTokensCount))
  let computed = (Double(Timings.generationStallPerTokenMs) * tokens).rounded()
  guard computed.isFinite, computed < Double(Int.max) else {
    throw TransportError(.error, "The generation's stall deadline cannot be represented")
  }
  return max(Timings.generationStallFloorMs, Int(computed))
}
