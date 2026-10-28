package semiont

// Gather: assembling the context a model is given, and what refers to a
// resource.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// What a caller that states nothing is given. Every SDK sends the same: the
// cases of specs/src/client/surface.json hold each to it.
const (
	gatherContextWindow = 2000
	gatherDepth         = 2
	gatherMaxResources  = 10
)

// GatherResourceDefaults is what Gather.Resource is given when nothing else
// is stated: two hops of the graph, ten resources, their content, and no
// summary.
func GatherResourceDefaults() api.GatherResourceRequestOptions {
	return api.GatherResourceRequestOptions{Depth: gatherDepth, MaxResources: gatherMaxResources, IncludeContent: true, IncludeSummary: false}
}

// GatherNamespace is assembling the context a model is given, and what
// refers to a resource.
type GatherNamespace struct {
	links *links
	live  *live
}

// Annotation is the context around one annotation, as options say: a window
// of two thousand characters of its source when ContextWindow is nil, and the
// source's context and the target's each included or left out as stated, and
// as the gatherer decides when nil.
func (n *GatherNamespace) Annotation(resourceID api.ResourceId, annotationID api.AnnotationId, options api.GatherAnnotationOptions) *Running[api.GatherAnnotationComplete] {
	if options.ContextWindow == nil {
		window := gatherContextWindow
		options.ContextWindow = &window
	}
	request := api.GatherAnnotationRequest{AnnotationId: annotationID, ResourceId: resourceID, Options: &options}
	return &Running[api.GatherAnnotationComplete]{links: n.links, work: func(ctx context.Context, _ func(api.GatherAnnotationComplete)) (api.GatherAnnotationComplete, error) {
		return ask(ctx, n.links, bus.GatherRequested, request)
	}}
}

// Resource is the context around a whole resource, gathered as options say
// (GatherResourceDefaults, when nothing else is to be stated). Depth is how
// many links out from the resource the graph reaches, 1 to 3, nearest first:
// what a resource links to and what cites it are both followed. An empty
// exclusion excludes nothing, and is not sent.
func (n *GatherNamespace) Resource(ctx context.Context, resourceID api.ResourceId, options api.GatherResourceRequestOptions) (api.GatheredContext, error) {
	if options.ExcludeEntityTypes != nil && len(*options.ExcludeEntityTypes) == 0 {
		options.ExcludeEntityTypes = nil
	}
	gathered, err := ask(ctx, n.links, bus.GatherResourceRequested, api.GatherResourceRequest{ResourceId: resourceID, Options: options})
	return gathered.Response, err
}

// ReferencedBy is the annotations elsewhere that refer to a resource.
// Watching it holds the resource's scope.
func (n *GatherNamespace) ReferencedBy(resourceID api.ResourceId) *Cached[[]api.GetReferencedByResponseReferencedByItem] {
	return keyed(n.links, n.live.referencedBy, resourceID, itself[[]api.GetReferencedByResponseReferencedByItem], resourceID)
}
