package semiont

// Match: searching, for what a reference could refer to, and for resources
// by text.

import (
	"context"
	"encoding/json"
	"errors"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// What a caller that states nothing is given. Every SDK sends the same: the
// cases of specs/src/client/surface.json hold each to it.
const (
	matchCandidates = 10
	listLimit       = 100
)

// ResourceFilters is what a list or a search of resources admits. Limit is
// how many it gives, the first hundred when it is zero; a nil filter admits
// every resource.
type ResourceFilters struct {
	Limit      int
	Archived   *bool
	EntityType *string
}

// limit is the number of resources the filters give.
func (f ResourceFilters) limit() int {
	if f.Limit == 0 {
		return listLimit
	}
	return f.Limit
}

// MatchSearchOptions is how a search for a reference's candidates is run.
// Limit is how many it gives, ten when it is zero; UseSemanticScoring scores
// by meaning, as it does when it is nil.
type MatchSearchOptions struct {
	Limit              int
	UseSemanticScoring *bool
}

// MatchNamespace is searching: for what a reference could refer to, and for
// resources by text.
type MatchNamespace struct {
	links *links
}

// Search is the candidates for a reference, given its gathered context.
func (n *MatchNamespace) Search(resourceID api.ResourceId, referenceID api.AnnotationId, gathered api.GatheredContext, options MatchSearchOptions) *Running[api.MatchSearchResult] {
	limit := options.Limit
	if limit == 0 {
		limit = matchCandidates
	}
	semantic := true
	if options.UseSemanticScoring != nil {
		semantic = *options.UseSemanticScoring
	}
	request := api.MatchSearchRequest{ResourceId: resourceID, ReferenceId: referenceID, Context: gathered, Limit: &limit, UseSemanticScoring: &semantic}
	return &Running[api.MatchSearchResult]{links: n.links, work: func(ctx context.Context, _ func(api.MatchSearchResult)) (api.MatchSearchResult, error) {
		result, err := ask(ctx, n.links, bus.MatchSearchRequested, request)
		var refused *BusRequestError
		if errors.As(err, &refused) && refused.Failure != nil {
			// A search's failure says what went wrong under `error`, where every other operation's says it under `message`.
			var said struct {
				Error *string `json:"error"`
			}
			if json.Unmarshal(refused.Failure, &said) == nil && said.Error != nil {
				return result, &BusRequestError{Code: refused.Code, Message: *said.Error, Failure: refused.Failure}
			}
		}
		return result, err
	}}
}

// RequestSearch signals that a search is wanted. The client's own state runs
// it, and answers under correlationID.
func (n *MatchNamespace) RequestSearch(input api.MatchSearchRequest, correlationID string) {
	signal(n.links, bus.MatchSearchRequested.Request(), input, Envelope{CorrelationID: correlationID})
}

// Resources is a page of the resources a search for search finds, among
// those filters admits. The text is matched lexically and, when nothing
// matches, by meaning: the answer's MatchKind says which it is.
func (n *MatchNamespace) Resources(search string, filters ResourceFilters) *Cached[api.MatchResourcesResponse] {
	limit, offset := filters.limit(), 0
	request := api.MatchResourcesRequest{Search: search, Limit: &limit, Offset: &offset, Archived: filters.Archived, EntityType: filters.EntityType}
	return &Cached[api.MatchResourcesResponse]{fetch: func(ctx context.Context) (api.MatchResourcesResponse, error) {
		answer, err := ask(ctx, n.links, bus.MatchResourcesRequested, request)
		return answer.Response, err
	}}
}
