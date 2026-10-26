package state

// A search as it is typed: a query, and the results of the query it last
// settled on.
//
// The query is whatever was last set. Once it has stayed the same for the
// debounce, it is searched for, unless it is the query already searched for.
// A query of nothing but spaces searches for nothing and has no results. A
// new query abandons the search before it. The query it begins with settles
// like any other.
//
// What it searches with is a function from a query to its answers, each
// given as a comma-ok pair: ok false while the answer is on its way, and the
// results with ok true once they are known, and again each time they change.
// A live query of the client is such a sequence, once each of its states is
// read as one or the other. A search that is abandoned has its context done,
// and the loop over its answers stops.

import (
	"context"
	"iter"
	"strings"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// SearchState is what a search shows: its results, and whether more are on
// their way.
type SearchState[T any] struct {
	Results     []T  `json:"results"`
	IsSearching bool `json:"isSearching"`
}

// SearchPipeline is a search as it is typed: see the file's documentation.
// Each state it shows is a new SearchState, read and not changed.
type SearchPipeline[T any] struct {
	search   func(ctx context.Context, query string) iter.Seq2[[]T, bool]
	debounce time.Duration

	query *semiont.Variable[string]
	state *semiont.Variable[*SearchState[T]]

	life
	// waiting is the debounce under way, and settling counts them, so one
	// that ran out as the query changed knows it did.
	waiting  *time.Timer
	settling int
	// searched is the query last searched for, once one has been.
	searched    string
	hasSearched bool
	// abandon abandons the search under way; nil when none is.
	abandon context.CancelFunc
}

var _ semiont.StateUnit = (*SearchPipeline[string])(nil)

// NewSearchPipeline is a pipeline searching with search, once a query has
// stayed the same for debounce (Timing.SearchDebounce, unless the caller says
// otherwise), beginning with initialQuery.
func NewSearchPipeline[T any](search func(ctx context.Context, query string) iter.Seq2[[]T, bool], debounce time.Duration, initialQuery string) *SearchPipeline[T] {
	p := &SearchPipeline[T]{
		search:   search,
		debounce: debounce,
		query:    semiont.NewVariable(initialQuery),
		state:    semiont.NewVariable(&SearchState[T]{Results: []T{}}),
		life:     newLife(),
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	// The query it begins with, which settles like any other.
	p.wait()
	return p
}

// Query is the query as it was last set.
func (p *SearchPipeline[T]) Query() semiont.Watched[string] { return p.query.Reading() }

// State is the results of the query it last settled on, and whether more are
// on their way.
func (p *SearchPipeline[T]) State() semiont.Watched[*SearchState[T]] { return p.state.Reading() }

// SetQuery sets the query. The same query again is no change, and waits no
// longer.
func (p *SearchPipeline[T]) SetQuery(value string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || value == p.query.Value() {
		return
	}
	p.query.Set(value)
	p.wait()
}

// wait starts the debounce over. Called with mu held.
func (p *SearchPipeline[T]) wait() {
	if p.waiting != nil {
		p.waiting.Stop()
	}
	p.settling++
	settling := p.settling
	p.waiting = time.AfterFunc(p.debounce, func() { p.settled(settling) })
}

// settled is a debounce that ran out: the query it began with has stayed the
// same, unless the query changed as it ran out.
func (p *SearchPipeline[T]) settled(settling int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed || settling != p.settling {
		return
	}
	p.waiting = nil
	query := p.query.Value()
	if p.hasSearched && query == p.searched {
		return
	}
	p.searched, p.hasSearched = query, true
	if p.abandon != nil {
		p.abandon()
		p.abandon = nil
	}
	wanted := strings.TrimSpace(query)
	if wanted == "" {
		p.state.Set(&SearchState[T]{Results: []T{}})
		return
	}
	p.state.Set(&SearchState[T]{Results: []T{}, IsSearching: true})
	following, abandon := context.WithCancel(p.alive)
	p.abandon = abandon
	go p.follow(following, p.search(following, wanted))
}

// follow shows each answer of a search until it is abandoned.
func (p *SearchPipeline[T]) follow(following context.Context, answers iter.Seq2[[]T, bool]) {
	for found, known := range answers {
		p.mu.Lock()
		if following.Err() != nil {
			p.mu.Unlock()
			return
		}
		if known {
			p.state.Set(&SearchState[T]{Results: append([]T{}, found...)})
		} else {
			p.state.Set(&SearchState[T]{Results: []T{}, IsSearching: true})
		}
		p.mu.Unlock()
	}
}

// Close ends the pipeline: the search under way is abandoned, and the query
// and the state end. Closing twice is closing once.
func (p *SearchPipeline[T]) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.close() {
		return
	}
	if p.waiting != nil {
		p.waiting.Stop()
	}
	p.query.End()
	p.state.End()
}
