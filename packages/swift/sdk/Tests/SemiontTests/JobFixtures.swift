import Foundation
import Testing

@testable import Semiont

func statusFixture(
  _ job: String = "job-1", kind: JobType = .mark, status: JobStatusResponseStatus = .complete,
  error: String? = nil
) throws -> JobStatusResponse {
  JobStatusResponse(
    created: "2026-11-03T00:00:00Z", error: error, jobId: try JobId(job), status: status,
    type: kind, userId: try UserId("did:web:kb.test:users:person"))
}
func contextFixture() throws -> GatheredContext {
  let table = try Spec.read("client/surface.json").object
  return try decoded(GatheredContext.self, required(required(table, "fixtures").object, "context"))
}
func jobCreatedFixture(_ job: String = "job-1") throws -> [String: JSONValue] {
  try wirePayload(JobCreatedResult(response: JobCreatedResultResponse(jobId: JobId(job))))
}
func completionFixture(_ create: JobCreateCommand, job: String = "job-1") throws
  -> JobCompleteCommand
{
  let job = try JobId(job)
  switch create {
  case .markJobCreateCommand(let command):
    return .markJobCompleteCommand(
      MarkJobCompleteCommand(jobId: job, resourceId: command.resourceId))
  case .yieldJobCreateCommand(let command):
    let resource: ResourceId
    switch command.params.context.focus {
    case .resource(let focus): resource = focus.resource.id
    case .annotation(let focus): resource = focus.sourceResource.id
    }
    return .yieldJobCompleteCommand(YieldJobCompleteCommand(jobId: job, resourceId: resource))
  }
}
func annotationReply(_ annotation: Annotation) throws -> [String: JSONValue] {
  try wirePayload(
    BrowseAnnotationResult(
      response: GetAnnotationResponse(annotation: annotation, resolvedResource: nil, resource: nil))
  )
}

func surfaceReplies(_ probe: ProbeTransport, cloneAnswer: JSONValue?) {
  probe.handle { [weak probe] name, payload in
    switch name {
    case Operations.browseEntityTypesRequested.request.name:
      return try wirePayload(
        BrowseEntityTypesResult(
          response: GetEntityTypesResponse(entityTypes: ["Person"])))
    case Operations.browseTagSchemasRequested.request.name:
      return try wirePayload(
        BrowseTagSchemasResult(response: GetTagSchemasResponse(tagSchemas: [])))
    case Operations.browseResourceRequested.request.name:
      guard case .resource(let focus) = try contextFixture().focus else {
        throw SpecFailure.shape("resource focus")
      }
      return try wirePayload(
        BrowseResourceResult(
          response: BrowseResourceResultResponse(lastSequence: 0, resource: focus.resource)))
    case Operations.gatherReferencedByRequested.request.name:
      return try wirePayload(
        GatherReferencedByResult(
          response: GetReferencedByResponse(referencedBy: [])))
    case Operations.browseEventsRequested.request.name:
      let request = try decoded(BrowseEventsRequest.self, .object(payload))
      return try wirePayload(
        BrowseEventsResult(
          response: GetEventsResponse(
            events: [], resourceId: request.resourceId, total: 0)))
    case Operations.browseAnnotationRequested.request.name:
      let request = try decoded(BrowseAnnotationRequest.self, .object(payload))
      return try annotationReply(
        Annotation(
          created: "2026-11-03T00:00:00Z", id: request.annotationId, motivation: .commenting,
          target: .resourceId(request.resourceId)))
    case Operations.browseAnnotationHistoryRequested.request.name:
      let request = try decoded(BrowseAnnotationHistoryRequest.self, .object(payload))
      return try wirePayload(
        BrowseAnnotationHistoryResult(
          response: GetAnnotationHistoryResponse(
            annotationId: request.annotationId, events: [], resourceId: request.resourceId, total: 0
          )))
    case Operations.browseDirectoryRequested.request.name:
      let request = try decoded(BrowseDirectoryRequest.self, .object(payload))
      return try wirePayload(
        BrowseDirectoryResult(
          response: BrowseDirectoryResultResponse(
            entries: [], path: request.path)))
    case Operations.browseKbRequested.request.name:
      return try wirePayload(
        BrowseKbResult(response: KbDescription(domain: "kb.test", name: "Test")))
    case Operations.jobCreate.request.name:
      let completion = try completionFixture(decoded(JobCreateCommand.self, .object(payload)))
      probe?.deliver(
        ReceivedFrame(channel: Channels.jobComplete.name, payload: try wirePayload(completion)))
      return try jobCreatedFixture()
    case Operations.jobStatusRequested.request.name:
      return try wirePayload(JobStatusResult(response: statusFixture()))
    case Operations.jobCancelRequested.request.name:
      return try wirePayload(ResponseEnvelope(response: JobCancelResult(cancelled: true)))
    case Operations.markDelete.request.name:
      let request = try decoded(MarkDeleteCommand.self, .object(payload))
      return try wirePayload(
        MarkDeleteOk(response: MarkDeleteOkResponse(annotationId: request.annotationId)))
    case Operations.markCreateRequest.request.name:
      return try wirePayload(
        ResponseEnvelope(response: MarkCreateOkResponse(annotationId: AnnotationId("ann-1"))))
    case Operations.gatherRequested.request.name:
      let request = try decoded(GatherAnnotationRequest.self, .object(payload))
      return try wirePayload(
        GatherAnnotationComplete(annotationId: request.annotationId, response: contextFixture()))
    case Operations.gatherResourceRequested.request.name:
      let request = try decoded(GatherResourceRequest.self, .object(payload))
      return try wirePayload(
        GatherResourceComplete(resourceId: request.resourceId, response: contextFixture()))
    case Operations.matchSearchRequested.request.name:
      let request = try decoded(MatchSearchRequest.self, .object(payload))
      return try wirePayload(MatchSearchResult(referenceId: request.referenceId, response: []))
    case Operations.yieldCloneResourceRequested.request.name,
      Operations.yieldCloneTokenRequested.request.name:
      guard case .resource(let focus) = try contextFixture().focus else {
        throw SpecFailure.shape("resource focus")
      }
      if name == Operations.yieldCloneTokenRequested.request.name {
        return try wirePayload(
          ResponseEnvelope(
            response: CloneResourceWithTokenResponse(
              expiresAt: "2030-01-01T00:00:00Z", resource: focus.resource, token: "token")))
      }
      if let cloneAnswer {
        return try wirePayload(
          ResponseEnvelope(response: decoded(GetResourceByTokenResponse.self, cloneAnswer)))
      }
      return try wirePayload(
        ResponseEnvelope(
          response: GetResourceByTokenResponse(
            expiresAt: "2030-01-01T00:00:00Z", sourceResource: focus.resource)))
    case Operations.frameAddEntityType.request.name, Operations.frameAddTagSchema.request.name,
      Operations.markArchive.request.name, Operations.markUnarchive.request.name,
      Operations.markUpdateEntityTypes.request.name:
      return try wirePayload(BusEmptyPayload())
    case Operations.bindUpdateBody.request.name:
      return try wirePayload(BindBodyUpdated())
    default: throw SpecFailure.shape("Unscripted surface operation: \(name)")
    }
  }
}
