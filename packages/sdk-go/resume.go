package semiont

// A stream's place in each scope, kept so the next client of the same
// knowledge base resumes from it. What that client kept of a scope is then
// brought up to date by the events recorded since, replayed.

import (
	"encoding/json"
	"maps"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
)

// Bookmarks is where a stream's place in each scope is kept across a
// client's lives. A client that starts with the places its last life reached
// is sent what was recorded since, and what it kept of those scopes is
// brought up to date by replay.
type Bookmarks interface {
	// Load is the id of the last recorded event delivered on each scope, as
	// kept.
	Load() map[api.ResourceId]string
	// Save says a recorded event was delivered on scope.
	Save(scope api.ResourceId, eventID string)
}

// CoupledBookmarks keeps a stream's places in a SessionStorage, coupled to
// the caches kept in the same storage.
//
// The place may lag the caches and never leads them. A place kept ahead of a
// cache would have the next client resume past an event the cache it begins
// with never took in. So a place is not written when it is reached. It is
// remembered, and written with the next write of a cache, and only when the
// gate says every kept cache is at rest: one that is still fetching, or owes
// a save, has not taken in the event the place names. A place that is not
// written is only late, which costs a replay.
//
// What is kept under the key and is not places reads as nothing kept.
//
//	places := semiont.NewCoupledBookmarks(storage, "semiont.lastEventId."+kb.Id)
//	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{..., Bookmarks: places})
//	client := semiont.NewClient(semiont.ClientConfig{..., Persistence: &semiont.CachePersistence{Storage: places.Storage(), KeyPrefix: kb.Id}})
//	places.SetFlushGate(client.PersistenceSettled)
type CoupledBookmarks struct {
	storage SessionStorage
	key     string

	mu sync.Mutex
	// pending is the places reached and not yet written.
	pending map[api.ResourceId]string
	atRest  func() bool
}

var _ Bookmarks = (*CoupledBookmarks)(nil)

// NewCoupledBookmarks is places kept in storage under key.
func NewCoupledBookmarks(storage SessionStorage, key string) *CoupledBookmarks {
	return &CoupledBookmarks{storage: storage, key: key, pending: map[api.ResourceId]string{}}
}

// Storage is the storage to give the caches: what they write goes to the
// storage beneath, and carries the places with it.
func (b *CoupledBookmarks) Storage() SessionStorage { return carrying{b} }

func (b *CoupledBookmarks) Load() map[api.ResourceId]string {
	stored, ok := b.storage.Get(b.key)
	if !ok {
		return map[api.ResourceId]string{}
	}
	var places map[api.ResourceId]string
	if json.Unmarshal([]byte(stored), &places) != nil || places == nil {
		return map[api.ResourceId]string{}
	}
	return places
}

// Save remembers that a place was reached in scope; it is written with a
// later write of a cache.
func (b *CoupledBookmarks) Save(scope api.ResourceId, eventID string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.pending[scope] = eventID
}

// SetFlushGate says when the caches are at rest. With no gate every write of
// a cache carries what is remembered.
func (b *CoupledBookmarks) SetFlushGate(atRest func() bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.atRest = atRest
}

// flush writes what is remembered, when the gate allows it; the error when
// the storage could not. The lock is held throughout, so no place reached
// after the gate was asked is written on its word.
func (b *CoupledBookmarks) flush() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pending) == 0 || (b.atRest != nil && !b.atRest()) {
		return nil
	}
	places := b.Load()
	maps.Copy(places, b.pending)
	b.pending = map[api.ResourceId]string{}
	written, err := json.Marshal(places)
	if err != nil {
		// Every scope was read from storage or delivered on the stream, so none is the zero id, the one a ResourceId refuses to write.
		panic(err)
	}
	return b.storage.Set(b.key, string(written))
}

// carrying is the storage beneath, where each write carries the places with
// it.
type carrying struct{ places *CoupledBookmarks }

func (c carrying) Get(key string) (string, bool) { return c.places.storage.Get(key) }

func (c carrying) Set(key, value string) error {
	if err := c.places.storage.Set(key, value); err != nil {
		// A write that failed carries no place.
		return err
	}
	return c.places.flush()
}

func (c carrying) Delete(key string) { c.places.storage.Delete(key) }
