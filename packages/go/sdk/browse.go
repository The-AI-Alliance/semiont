package semiont

// Browse: reads, and this viewer's own signals. The queries (Cached) are
// read once with Fresh. The one-shot reads are asked once. The signals are
// this viewer's own, with the one report among them going over the wire.

import (
	"context"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// EngineWithLimits is one of the knowledge base's engines: its entry, and
// its model's limits when the service holding that model's credentials
// reported them (nil when none did).
type EngineWithLimits struct {
	Entry  api.EngineEntry
	Limits *api.InferenceLimits
}

// joined is the engines, each with the limits it was reported to have. The
// first report of an engine is the one that stands.
func joined(entries []api.EngineEntry, reported []api.EngineLimits) []EngineWithLimits {
	byEngine := map[api.Engine]api.InferenceLimits{}
	for i := len(reported) - 1; i >= 0; i-- {
		byEngine[reported[i].Engine] = reported[i].Limits
	}
	engines := make([]EngineWithLimits, 0, len(entries))
	for _, entry := range entries {
		engine := EngineWithLimits{Entry: entry}
		if limits, ok := byEngine[entry.Engine]; ok {
			engine.Limits = &limits
		}
		engines = append(engines, engine)
	}
	return engines
}

// BrowseNamespace is reads, and this viewer's own signals.
type BrowseNamespace struct {
	links   *links
	content ContentTransport
	live    *live
}

// Resource is one resource's description. Watching it holds the resource's
// scope.
func (n *BrowseNamespace) Resource(resourceID api.ResourceId) *Cached[api.ResourceDescriptor] {
	return keyed(n.links, n.live.resource, resourceID, itself[api.ResourceDescriptor], resourceID)
}

// Resources is a page of the knowledge base's resources, among those filters
// admits. It is kept true by what every client hears and by the events of the
// resources this client holds the scope of, and by nothing else. Finding
// resources by text is Match.Resources.
func (n *BrowseNamespace) Resources(filters ResourceFilters) *Cached[api.ListResourcesResponse] {
	return keyed(n.links, n.live.lists, keyOf(filters), itself[api.ListResourcesResponse], api.ResourceId{})
}

// Annotations is a resource's annotations. Watching it holds the resource's
// scope.
func (n *BrowseNamespace) Annotations(resourceID api.ResourceId) *Cached[[]api.Annotation] {
	return keyed(n.links, n.live.annotations, resourceID, func(answer api.GetAnnotationsResponse) []api.Annotation { return answer.Annotations }, resourceID)
}

// Annotation is one annotation of a resource. Watching it holds the
// resource's scope.
func (n *BrowseNamespace) Annotation(resourceID api.ResourceId, annotationID api.AnnotationId) *Cached[api.Annotation] {
	n.live.annotationOn(annotationID, resourceID)
	return keyed(n.links, n.live.annotation, annotationID, itself[api.Annotation], resourceID)
}

// EntityTypes is the knowledge base's entity types.
func (n *BrowseNamespace) EntityTypes() *Cached[[]string] {
	return keyed(n.links, n.live.entityTypes, whole{}, itself[[]string], api.ResourceId{})
}

// TagSchemas is the knowledge base's tag schemas.
func (n *BrowseNamespace) TagSchemas() *Cached[[]api.TagSchema] {
	return keyed(n.links, n.live.tagSchemas, whole{}, itself[[]api.TagSchema], api.ResourceId{})
}

// Engines is the knowledge base's engines, asked for first, with each
// model's limits as the services holding its credentials report them. A
// service that is down, silent or mistaken reports none: its models show no
// limits. Engines that cannot be had fail the read at once.
func (n *BrowseNamespace) Engines() *Cached[[]EngineWithLimits] {
	return n.live.enginesWithLimits()
}

// Events is a resource's events, each with who it is attributed to.
// Watching it holds the resource's scope.
func (n *BrowseNamespace) Events(resourceID api.ResourceId) *Cached[[]api.AttributedEvent] {
	return keyed(n.links, n.live.events, resourceID, itself[[]api.AttributedEvent], resourceID)
}

// ResourceContent is a resource's text, read out of its bytes by the rule
// every reader of a resource's text keeps (DecodeRepresentation).
func (n *BrowseNamespace) ResourceContent(ctx context.Context, resourceID api.ResourceId) (string, error) {
	content, err := n.content.GetBinary(ctx, resourceID)
	if err != nil {
		return "", err
	}
	return DecodeRepresentation(content.Bytes, content.ContentType)
}

// ResourceGraph is a resource's description as linked data.
func (n *BrowseNamespace) ResourceGraph(ctx context.Context, resourceID api.ResourceId) (api.GetResourceResponse, error) {
	return n.content.GetResourceGraph(ctx, resourceID)
}

// ResourceAnchoredText is a resource's anchored text: the text read out of
// its content, with where each run of it is on a page.
func (n *BrowseNamespace) ResourceAnchoredText(ctx context.Context, resourceID api.ResourceId) (api.AnchoredTextAnswer, error) {
	return n.content.GetAnchoredText(ctx, resourceID)
}

// ResourceRepresentation is a resource's bytes, with their media type.
func (n *BrowseNamespace) ResourceRepresentation(ctx context.Context, resourceID api.ResourceId) (Content, error) {
	return n.content.GetBinary(ctx, resourceID)
}

// ResourceRepresentationStream is a resource's bytes as they arrive, with
// their media type.
func (n *BrowseNamespace) ResourceRepresentationStream(ctx context.Context, resourceID api.ResourceId) (ContentStream, error) {
	return n.content.GetBinaryStream(ctx, resourceID)
}

// ResourceEvents is a resource's events, each with who it is attributed to,
// asked for now.
func (n *BrowseNamespace) ResourceEvents(ctx context.Context, resourceID api.ResourceId) ([]api.AttributedEvent, error) {
	answer, err := ask(ctx, n.links, bus.BrowseEventsRequested, api.BrowseEventsRequest{ResourceId: resourceID})
	return answer.Response.Events, err
}

// AnnotationHistory is an annotation's history: the events of the record
// that made it what it is.
func (n *BrowseNamespace) AnnotationHistory(ctx context.Context, resourceID api.ResourceId, annotationID api.AnnotationId) (api.GetAnnotationHistoryResponse, error) {
	answer, err := ask(ctx, n.links, bus.BrowseAnnotationHistoryRequested, api.BrowseAnnotationHistoryRequest{ResourceId: resourceID, AnnotationId: annotationID})
	return answer.Response, err
}

// Files is a directory of the knowledge base's working tree, its entries in
// sort's order: the root, by name, when dirPath and sort are empty.
func (n *BrowseNamespace) Files(ctx context.Context, dirPath string, sort api.BrowseDirectoryRequestSort) (api.BrowseDirectoryResultResponse, error) {
	if dirPath == "" {
		dirPath = "."
	}
	if sort == "" {
		sort = api.BrowseDirectoryRequestSortName
	}
	answer, err := ask(ctx, n.links, bus.BrowseDirectoryRequested, api.BrowseDirectoryRequest{Path: dirPath, Sort: &sort})
	return answer.Response, err
}

// Kb is what the knowledge base says of itself. Asked every time: a branch
// changes with no event to say so.
func (n *BrowseNamespace) Kb(ctx context.Context) (api.KbDescription, error) {
	answer, err := ask(ctx, n.links, bus.BrowseKbRequested, api.BrowseKbRequest{})
	return answer.Response, err
}

// Click signals that this viewer clicked an annotation.
func (n *BrowseNamespace) Click(annotationID api.AnnotationId) {
	signal(n.links, bus.BrowseClick, api.BrowseClickEvent{AnnotationId: annotationID}, Envelope{})
}

// OpenResource signals that this viewer opens a resource.
func (n *BrowseNamespace) OpenResource(resourceID api.ResourceId) {
	signal(n.links, bus.BrowseResourceOpen, api.BrowseResourceOpenEvent{ResourceId: resourceID}, Envelope{})
}

// ResourceViewed reports that this viewer viewed a resource. A report, so it
// goes over the wire; nothing awaits it.
func (n *BrowseNamespace) ResourceViewed(resourceID api.ResourceId) {
	report(n.links, bus.BrowseResourceViewed, api.BrowseResourceViewedEvent{ResourceId: resourceID})
}
