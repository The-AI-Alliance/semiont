package semiont

// Bind: linking a reference to what it refers to.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// BindNamespace is linking a reference to what it refers to.
type BindNamespace struct {
	links *links
}

// Body applies operations to an annotation's body: adding, removing or
// replacing what it links to. It returns when the knowledge base says the
// body is recorded.
func (n *BindNamespace) Body(ctx context.Context, resourceID api.ResourceId, annotationID api.AnnotationId, operations []api.BindBodyOperation) error {
	_, err := ask(ctx, n.links, bus.BindUpdateBody, api.BindUpdateBodyCommand{AnnotationId: annotationID, ResourceId: resourceID, Operations: operations})
	return err
}

// Initiate signals that the linking of a reference is begun.
func (n *BindNamespace) Initiate(input api.BindInitiateCommand) {
	signal(n.links, bus.BindInitiate, input, Envelope{})
}

// ReportBodyError signals that a body's update failed where nothing could
// show it. Said by whoever waited for Body, which knows the resource.
func (n *BindNamespace) ReportBodyError(input api.ResourceErrorEvent) {
	signal(n.links, bus.BindBodyError, input, Envelope{})
}
