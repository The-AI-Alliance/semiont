package semiont

// Browse: reads, and this viewer's own signals. The queries (Cached) are
// read once with Fresh. The one-shot reads are asked once. The signals are
// this viewer's own, with the one report among them going over the wire.

import (
	"context"
	"errors"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Collaborator is one collaborator of the knowledge base: its entry in the
// directory, and its model's limits when the service holding that model's
// credentials reported them (nil when none did).
type Collaborator struct {
	Entry  api.CollaboratorEntry
	Limits *api.InferenceLimits
}

// joined is the directory, each software agent with the limits its model was
// reported to have. The first report of a model is the one that stands.
func joined(directory []api.CollaboratorEntry, reported []api.InferencePairLimits) []Collaborator {
	type model struct{ provider, model string }
	byModel := map[model]api.InferenceLimits{}
	for i := len(reported) - 1; i >= 0; i-- {
		byModel[model{reported[i].Provider, reported[i].Model}] = reported[i].Limits
	}
	collaborators := make([]Collaborator, 0, len(directory))
	for _, entry := range directory {
		collaborator := Collaborator{Entry: entry}
		if kind, err := entry.Agent.Discriminator(); err == nil && kind == string(api.AgentSoftwareTypeSoftware) {
			if software, err := entry.Agent.AsAgentSoftware(); err == nil && software.Provider != nil && software.Model != nil {
				if limits, ok := byModel[model{*software.Provider, *software.Model}]; ok {
					collaborator.Limits = &limits
				}
			}
		}
		collaborators = append(collaborators, collaborator)
	}
	return collaborators
}

// BrowseNamespace is reads, and this viewer's own signals.
type BrowseNamespace struct {
	links   *links
	content ContentTransport
}

// Resource is one resource's description.
func (n *BrowseNamespace) Resource(resourceID api.ResourceId) *Cached[api.ResourceDescriptor] {
	return &Cached[api.ResourceDescriptor]{fetch: func(ctx context.Context) (api.ResourceDescriptor, error) {
		answer, err := ask(ctx, n.links, bus.BrowseResourceRequested, api.BrowseResourceRequest{ResourceId: resourceID})
		return answer.Response.Resource, err
	}}
}

// Resources is a page of the knowledge base's resources, among those filters
// admits. Finding resources by text is Match.Resources.
func (n *BrowseNamespace) Resources(filters ResourceFilters) *Cached[api.ListResourcesResponse] {
	limit, offset := filters.limit(), 0
	request := api.BrowseResourcesRequest{Limit: &limit, Offset: &offset, Archived: filters.Archived, EntityType: filters.EntityType}
	return &Cached[api.ListResourcesResponse]{fetch: func(ctx context.Context) (api.ListResourcesResponse, error) {
		answer, err := ask(ctx, n.links, bus.BrowseResourcesRequested, request)
		return answer.Response, err
	}}
}

// Annotations is a resource's annotations.
func (n *BrowseNamespace) Annotations(resourceID api.ResourceId) *Cached[[]api.Annotation] {
	return &Cached[[]api.Annotation]{fetch: func(ctx context.Context) ([]api.Annotation, error) {
		answer, err := n.content.GetAnnotations(ctx, resourceID)
		return answer.Annotations, err
	}}
}

// Annotation is one annotation of a resource.
func (n *BrowseNamespace) Annotation(resourceID api.ResourceId, annotationID api.AnnotationId) *Cached[api.Annotation] {
	return &Cached[api.Annotation]{fetch: func(ctx context.Context) (api.Annotation, error) {
		answer, err := ask(ctx, n.links, bus.BrowseAnnotationRequested, api.BrowseAnnotationRequest{ResourceId: resourceID, AnnotationId: annotationID})
		return answer.Response.Annotation, err
	}}
}

// EntityTypes is the knowledge base's entity types.
func (n *BrowseNamespace) EntityTypes() *Cached[[]string] {
	return &Cached[[]string]{fetch: func(ctx context.Context) ([]string, error) {
		answer, err := ask(ctx, n.links, bus.BrowseEntityTypesRequested, api.BrowseEntityTypesRequest{})
		return answer.Response.EntityTypes, err
	}}
}

// TagSchemas is the knowledge base's tag schemas.
func (n *BrowseNamespace) TagSchemas() *Cached[[]api.TagSchema] {
	return &Cached[[]api.TagSchema]{fetch: func(ctx context.Context) ([]api.TagSchema, error) {
		answer, err := ask(ctx, n.links, bus.BrowseTagSchemasRequested, api.BrowseTagSchemasRequest{})
		return answer.Response.TagSchemas, err
	}}
}

// Agents is the directory, asked for first, with each model's limits as the
// services holding its credentials report them. A service that is down,
// silent or mistaken reports none: its models show no limits, and the
// directory is not held up by it for longer than a request waits.
func (n *BrowseNamespace) Agents() *Cached[[]Collaborator] {
	return &Cached[[]Collaborator]{fetch: func(ctx context.Context) ([]Collaborator, error) {
		var directory api.BrowseAgentsResult
		var unlisted error
		reports := make([]api.InferenceLimitsResult, len(bus.LimitsOperations))
		unreported := make([]error, len(bus.LimitsOperations))
		// The directory is asked for first; each key holder's limits after it, while it is answered.
		directoryAsked := make(chan struct{})
		var once sync.Once
		asking := func() { once.Do(func() { close(directoryAsked) }) }
		var asked sync.WaitGroup
		asked.Add(1 + len(bus.LimitsOperations))
		go func() {
			defer asked.Done()
			defer asking()
			directory, unlisted = requestAsking(ctx, n.links.wire, bus.BrowseAgentsRequested, api.BrowseAgentsRequest{}, n.links.timing.BusRequestTimeout, asking)
		}()
		for i, holder := range bus.LimitsOperations {
			go func() {
				defer asked.Done()
				<-directoryAsked
				reports[i], unreported[i] = ask(ctx, n.links, holder, api.InferenceLimitsRequest{})
			}()
		}
		asked.Wait()
		if unlisted != nil {
			return nil, unlisted
		}
		var reported []api.InferencePairLimits
		for i, report := range reports {
			var refused Error
			switch {
			case unreported[i] == nil:
				reported = append(reported, report.Response.Limits...)
			case !errors.As(unreported[i], &refused):
				return nil, unreported[i]
			}
		}
		return joined(directory.Response.Agents, reported), nil
	}}
}

// Events is a resource's events, each with who it is attributed to.
func (n *BrowseNamespace) Events(resourceID api.ResourceId) *Cached[[]api.AttributedEvent] {
	return &Cached[[]api.AttributedEvent]{fetch: func(ctx context.Context) ([]api.AttributedEvent, error) {
		return n.ResourceEvents(ctx, resourceID)
	}}
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
