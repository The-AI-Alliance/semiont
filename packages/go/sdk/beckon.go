package semiont

// Beckon: attention. The drives go over the wire, to every other
// participant, and give how many the gateway reached, or counted false when
// it kept no count. The signals are this viewer's own and never leave the
// client.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// BeckonNamespace is attention: driving the other participants' viewers.
type BeckonNamespace struct {
	links *links
}

// Attention points the other participants at an annotation, or, when
// annotationID is nil, at the resource as a whole.
func (n *BeckonNamespace) Attention(ctx context.Context, resourceID api.ResourceId, annotationID *api.AnnotationId) (subscribers int, counted bool, err error) {
	return drive(ctx, n.links, bus.BeckonFocus, api.BeckonFocusEvent{AnnotationId: annotationID, ResourceId: resourceID})
}

// Click opens an annotation on the other participants' screens.
func (n *BeckonNamespace) Click(ctx context.Context, annotationID api.AnnotationId) (subscribers int, counted bool, err error) {
	return drive(ctx, n.links, bus.BrowseClick, api.BrowseClickEvent{AnnotationId: annotationID})
}

// OpenResource opens a resource on the other participants' screens.
func (n *BeckonNamespace) OpenResource(ctx context.Context, resourceID api.ResourceId) (subscribers int, counted bool, err error) {
	return drive(ctx, n.links, bus.BrowseResourceOpen, api.BrowseResourceOpenEvent{ResourceId: resourceID})
}

// SparkleAll sparkles an annotation on every participant's viewer.
func (n *BeckonNamespace) SparkleAll(ctx context.Context, annotationID api.AnnotationId) (subscribers int, counted bool, err error) {
	return drive(ctx, n.links, bus.BeckonSparkle, api.BeckonSparkleEvent{AnnotationId: annotationID})
}

// Hover signals that this viewer hovers an annotation, or none when
// annotationID is nil.
func (n *BeckonNamespace) Hover(annotationID *api.AnnotationId) {
	signal(n.links, bus.BeckonHover, api.BeckonHoverEvent{AnnotationId: annotationID}, Envelope{})
}

// Sparkle signals: sparkle an annotation on this viewer alone.
func (n *BeckonNamespace) Sparkle(annotationID api.AnnotationId) {
	signal(n.links, bus.BeckonSparkle, api.BeckonSparkleEvent{AnnotationId: annotationID}, Envelope{})
}
