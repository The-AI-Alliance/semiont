package semiont

// A stream's place in each scope, kept so the next client of the same
// knowledge base resumes from it. What that client kept of a scope is then
// brought up to date by the events recorded since, replayed.

import (
	"encoding/json"
	"maps"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
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
// the caches kept in the same storage, as
// protocol/specs/src/session/stored.json's `lastEventIds`: an object from a
// resource's id to a PersistedEventId.
//
// The place may lag the caches and never leads them. A place kept ahead of a
// cache would have the next client resume past an event the cache it begins
// with never took in. So a place is not written when it is reached. It is
// remembered, and written with the next write of a cache, and only when the
// gate says what is kept is at rest: a cache that is still fetching, or owes
// a save, or a refetch the refresher still owes, has not taken in the event
// the place names. A place that is not written is only late, which costs a
// replay. The client's Close reads the gate once, before it disposes
// anything, and a save then owed does not hold the places back: what is
// written after is the places noted before that reading, and a place noted
// after it is not kept.
//
// A pair kept under the key that is not a resource's id and a
// PersistedEventId is skipped; what is no object is no places.
//
//	places := semiont.NewCoupledBookmarks(storage, semiont.LastEventIDKey(kb.Id, personKey))
//	transport := semiont.NewHTTPTransport(semiont.HTTPTransportConfig{..., Bookmarks: places})
//	client := semiont.NewClient(semiont.ClientConfig{..., Persistence: &semiont.CachePersistence{Storage: places.Storage(), KbID: kb.Id, PersonKey: personKey}})
//	places.CoupleTo(client)
type CoupledBookmarks struct {
	storage SessionStorage
	key     string

	mu sync.Mutex
	// pending is the places reached and not yet written.
	pending map[api.ResourceId]string
	atRest  func() bool
	// sealed is whether the client's Close has read the gate: pending is then
	// all that is written.
	sealed bool
}

var _ Bookmarks = (*CoupledBookmarks)(nil)

// NewCoupledBookmarks is places kept in storage under key.
func NewCoupledBookmarks(storage SessionStorage, key string) *CoupledBookmarks {
	return &CoupledBookmarks{storage: storage, key: key, pending: map[api.ResourceId]string{}}
}

// Storage is the storage to give the caches: what they write goes to the
// storage beneath, and carries the places with it.
func (b *CoupledBookmarks) Storage() SessionStorage { return carrying{b} }

// placeSchema is the schema of a place, as `lastEventIds` names it.
const placeSchema = "PersistedEventId"

// persisted reports whether id is a recorded event's, and so a place.
func persisted(id string) bool { return required.Holds(placeSchema, id) }

func (b *CoupledBookmarks) Load() map[api.ResourceId]string {
	places := map[api.ResourceId]string{}
	stored, ok := b.storage.Get(b.key)
	if !ok {
		return places
	}
	var pairs map[string]any
	if json.Unmarshal([]byte(stored), &pairs) != nil {
		return places
	}
	for scope, place := range pairs {
		resource, err := api.ParseResourceId(scope)
		eventID, isText := place.(string)
		if err != nil || !isText || !persisted(eventID) {
			continue
		}
		places[resource] = eventID
	}
	return places
}

// Save remembers that a place was reached in scope; it is written with a
// later write of a cache. An id that is no PersistedEventId is no place, and
// one reached after the client's Close read the gate is not kept.
func (b *CoupledBookmarks) Save(scope api.ResourceId, eventID string) {
	if !persisted(eventID) {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sealed {
		return
	}
	b.pending[scope] = eventID
}

// CoupleTo couples the places to what client keeps: they are written only
// while it is at rest (Client.PersistenceSettled), and once its Close has
// begun, only those noted before Close read that. With no client every write
// of a cache carries what is remembered.
func (b *CoupledBookmarks) CoupleTo(client *Client) {
	b.gatedBy(client.PersistenceSettled)
	client.places.Store(b)
}

// gatedBy says when what is kept is at rest.
func (b *CoupledBookmarks) gatedBy(atRest func() bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.atRest = atRest
}

// seal is Close's one reading of the gate, settled: the places pending then
// are what is written after, and none at all unless it was settled. The lock
// is held throughout, so a place is noted wholly before the reading or not
// kept.
func (b *CoupledBookmarks) seal(settled func() bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.sealed {
		return
	}
	b.sealed = true
	if !settled() {
		clear(b.pending)
	}
}

// flush writes what is remembered, when the gate allows it or Close's
// reading of it did; the error when the storage could not. The lock is held
// throughout, so no place reached after the gate was asked is written on its
// word.
func (b *CoupledBookmarks) flush() error {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.pending) == 0 || (!b.sealed && b.atRest != nil && !b.atRest()) {
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

func (c carrying) Delete(key string) error { return c.places.storage.Delete(key) }

func (c carrying) Update(key string, change func(stored string, has bool) (string, bool)) error {
	if err := c.places.storage.Update(key, change); err != nil {
		return err
	}
	return c.places.flush()
}

func (c carrying) Subscribe(onChange func(key, value string, has bool)) (func(), bool) {
	return c.places.storage.Subscribe(onChange)
}
