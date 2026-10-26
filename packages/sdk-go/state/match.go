package state

// Matching, run for whoever asks on the client's own bus.
//
// A search is asked for by a signal (Match.RequestSearch), which carries a
// correlation id. This unit runs it, and answers on the same bus under the
// same id: match:search-results, or match:search-failed with the reference it
// was for and what went wrong. It holds no state of its own: what it found is
// what it said.

import (
	"github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// MatchStateUnit runs the searches asked for on its client's own bus: see
// the file's documentation.
type MatchStateUnit struct {
	client *semiont.Client
	life
}

var _ semiont.StateUnit = (*MatchStateUnit)(nil)

// NewMatchStateUnit is a unit matching over client. It hears the client's
// own bus from now on.
func NewMatchStateUnit(client *semiont.Client) *MatchStateUnit {
	u := &MatchStateUnit{client: client, life: newLife()}
	// Taken now, so that a search asked for from here on is heard.
	u.listen(client.Bus.FramesOn(u.alive, bus.MatchSearchRequested.Request().Channel(), api.ResourceId{}), u.heard)
	return u
}

// heard runs a search asked for. A frame that is not a request's is nobody's
// to act on.
func (u *MatchStateUnit) heard(frame semiont.Frame) {
	asked, err := semiont.Decoded(bus.MatchSearchRequested.Request(), frame)
	if err == nil {
		go u.search(asked.Payload, asked.CorrelationID)
	}
}

// search runs one search, and says what it came to under the asker's id. A
// request that states no option of the search leaves it to the namespace.
func (u *MatchStateUnit) search(request api.MatchSearchRequest, correlationID string) {
	options := semiont.MatchSearchOptions{UseSemanticScoring: request.UseSemanticScoring}
	if request.Limit != nil {
		options.Limit = *request.Limit
	}
	found, err := u.client.Match.Search(request.ResourceId, request.ReferenceId, request.Context, options).Wait(u.alive)
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return
	}
	answer := semiont.Envelope{CorrelationID: correlationID}
	if err != nil {
		_ = semiont.Publish(u.client.Bus, bus.MatchSearchFailed, api.MatchSearchFailed{ReferenceId: request.ReferenceId, Error: err.Error()}, answer)
		return
	}
	_ = semiont.Publish(u.client.Bus, bus.MatchSearchResults, found, answer)
}

// Close ends the unit: the searches under way are abandoned, and nothing
// more is heard or said. Closing twice is closing once.
func (u *MatchStateUnit) Close() {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.close()
}
