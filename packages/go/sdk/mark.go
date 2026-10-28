package semiont

// Mark: annotations, a resource's own metadata, and the annotating of a
// resource delegated as a job. Each write is confirmed: it returns when the
// knowledge base says it is recorded, and fails with the failure it answered.
// What changed then arrives on the browse queries.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// MarkNamespace is annotations, a resource's own metadata, and the
// annotating of a resource delegated as a job.
type MarkNamespace struct {
	links *links
}

// Annotation creates an annotation on the resource its target names.
func (n *MarkNamespace) Annotation(ctx context.Context, input api.CreateAnnotationRequest) (api.MarkCreateOkResponse, error) {
	created, err := ask(ctx, n.links, bus.MarkCreateRequest, api.MarkCreateRequest{ResourceId: input.Target.Source, Request: input})
	return created.Response, err
}

// Delete deletes an annotation.
func (n *MarkNamespace) Delete(ctx context.Context, resourceID api.ResourceId, annotationID api.AnnotationId) error {
	_, err := ask(ctx, n.links, bus.MarkDelete, api.MarkDeleteCommand{AnnotationId: annotationID, ResourceId: &resourceID})
	return err
}

// Archive archives a resource.
func (n *MarkNamespace) Archive(ctx context.Context, resourceID api.ResourceId) error {
	_, err := ask(ctx, n.links, bus.MarkArchive, api.MarkArchiveCommand{ResourceId: resourceID})
	return err
}

// Unarchive brings an archived resource back.
func (n *MarkNamespace) Unarchive(ctx context.Context, resourceID api.ResourceId) error {
	_, err := ask(ctx, n.links, bus.MarkUnarchive, api.MarkUnarchiveCommand{ResourceId: resourceID})
	return err
}

// UpdateEntityTypes replaces a resource's own entity types: current is what
// it has now, updated the whole set it is to have.
func (n *MarkNamespace) UpdateEntityTypes(ctx context.Context, resourceID api.ResourceId, current, updated []string) error {
	_, err := ask(ctx, n.links, bus.MarkUpdateEntityTypes, api.MarkUpdateEntityTypesCommand{ResourceId: resourceID, CurrentEntityTypes: current, UpdatedEntityTypes: updated})
	return err
}

// Delegate delegates the annotating of a resource, as a mark job: its
// progress, any attempt that will be tried again, and its completion. params
// is the job's parameters, one shape for each motivation, and its motivation
// says which.
func (n *MarkNamespace) Delegate(resourceID api.ResourceId, params api.MarkJobParams) *Delegation[api.MarkJobCompleteCommand] {
	var create api.JobCreateCommand
	if err := create.FromMarkJobCreateCommand(api.MarkJobCreateCommand{JobType: api.MarkJobCreateCommandJobTypeMark, ResourceId: resourceID, Params: params}); err != nil {
		return refused[api.MarkJobCompleteCommand](n.links, err)
	}
	return follow[api.MarkJobCompleteCommand](n.links, create, api.JobTypeMark, resourceID, nil)
}

// Request signals that a new annotation is wanted on source.
func (n *MarkNamespace) Request(source api.ResourceId, selector api.AnnotationSelector, motivation api.Motivation) {
	signal(n.links, bus.MarkRequested, api.MarkRequestedEvent{Source: source, Selector: selector, Motivation: motivation}, Envelope{})
}

// Submit signals: submit the annotation that is pending.
func (n *MarkNamespace) Submit(input api.MarkSubmitEvent) {
	signal(n.links, bus.MarkSubmit, input, Envelope{})
}

// ReportDeleteError signals that a delete failed where nothing could show
// it. Said by whoever waited for Delete, which knows the resource.
func (n *MarkNamespace) ReportDeleteError(input api.ResourceErrorEvent) {
	signal(n.links, bus.MarkDeleteError, input, Envelope{})
}
