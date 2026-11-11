package semiont

// A read-through cache: what a client's live queries answer from
// (protocol/contract/CACHE-SEMANTICS.md, B1 to B20).

import (
	"context"
	"errors"
	"iter"
	"log/slog"
	"sync"
	"time"
)

// CacheState is a key's state, the same for every observer of the key:
// Pending (no value yet; a fetch may be in flight), Ready (a value, which may
// be the one shown while a newer is fetched), or Failed (a key with no value
// whose fetch, and its one retry, failed). Failed is a state, not the end of
// anything: an observer lives through it, and the next act on the key tries
// again. Read it with a type switch.
type CacheState interface {
	cacheState()
}

// Pending is a key with no value yet.
type Pending struct{}

// Ready is a key's value.
type Ready[V any] struct {
	Value V
}

// Failed is a key with no value, whose fetch for one failed, and failed
// again; or a key whose entity is gone.
type Failed struct {
	Err error
}

func (Pending) cacheState()  {}
func (Ready[V]) cacheState() {}
func (Failed) cacheState()   {}

// CachePersister is where a cache keeps its values, so a later one begins
// with them.
type CachePersister[K comparable, V any] interface {
	// Load is what was kept, asked once, when the cache is made; nil when
	// nothing was.
	Load() map[K]V
	// Save keeps entries: the cache's values, after they changed; the error
	// when they could not be kept.
	Save(entries map[K]V) error
}

// closedRead is what a read of a closed client fails as: what a request of
// a closed bus does.
func closedRead() error {
	return &BusRequestError{Code: BusRequestErrorCodeClosed, Message: "The client is closed"}
}

// flight is one fetch of a key: what it came to once done is closed. What
// goes with it when it is let go of, asked and patches, is read and written
// with the cache's mu held.
type flight[V any] struct {
	done  chan struct{}
	value V
	err   error
	// asked is which of the live view's asks it is (B14).
	asked liveAsk
	// patches are those made while it was in flight, to apply to its answer
	// in the order made (B13b).
	patches []func(V) V
}

// liveAsk is which of the live view's asks a flight is (B14); the zero value
// is a flight no ask of the live view waits on.
type liveAsk int

const (
	// firstLiveAsk is owed one more ask if it fails.
	firstLiveAsk liveAsk = iota + 1
	// retryLiveAsk is that one more.
	retryLiveAsk
)

// cacheKey is one key's: its state, and its current fetch.
type cacheKey[V any] struct {
	state CacheState
	// changed is closed when the state changes, and replaced.
	changed chan struct{}
	// inFlight is the key's current fetch. One an Invalidate, a Set or a
	// Remove let go of is in flight no more, and what it answers is not
	// stored (B9).
	inFlight *flight[V]
}

// known reports whether anything asked for the key and has not let go of it.
func (k *cacheKey[V]) known() bool {
	_, pending := k.state.(Pending)
	return k.inFlight != nil || !pending
}

// Cache is a read-through cache of V by K, and a StateUnit. Its fetches run
// as the client's work (run), each asking fetch for a key's value.
//
// A key has one state, and every observer of the key holds it. Observing is
// the live view: the first observer of a key with nothing starts a fetch;
// later ones are given what is there. A failed fetch is tried once more; a
// key with a value keeps showing it whatever its refetches do. Fetch is the
// one-shot read: it always asks, gives what it was answered or the failure it
// met, and never retries.
//
// A cache with a persister begins with what was kept and saves its values
// saveWait after they last changed. A save the persister refuses leaves the
// save owed: the next change, or the cache's closing, makes it again; a
// closing waits for a save being made, so one refused meanwhile is made by
// the closing. A value
// that was kept is shown at once and asked for again the first time it is
// observed: nothing says it is still true. An observer that falls behind is
// given the latest state, not each one it missed.
type Cache[K comparable, V any] struct {
	fetch     func(ctx context.Context, key K) (V, error)
	run       func(work func(ctx context.Context))
	persister CachePersister[K, V]
	// refused is told each save the persister refuses, as the persister
	// answered it.
	refused  func(error)
	saveWait time.Duration
	// saves is held by each save from the moment it takes the values until
	// the persister has answered, and by Close throughout: one save at a
	// time. Taken before mu, never while mu is held.
	saves sync.Mutex

	mu   sync.Mutex
	keys map[K]*cacheKey[V]
	kept map[K]bool
	// saving makes the save owed once the values stop changing; nil while
	// none is waiting.
	saving *time.Timer
	// owed is whether the values have changed since a save last took them,
	// or the persister refused the save that did: a save is owed.
	owed   bool
	closed bool
}

var _ StateUnit = (*Cache[string, string])(nil)

// NewCache is a cache whose fetches run by run and ask fetch. With a
// persister, it begins with what that kept, and saves to it saveWait after
// its values last changed, logging a save the persister refuses; persister is
// nil for a cache that keeps nothing.
func NewCache[K comparable, V any](fetch func(ctx context.Context, key K) (V, error), run func(work func(ctx context.Context)), persister CachePersister[K, V], saveWait time.Duration) *Cache[K, V] {
	c := &Cache[K, V]{fetch: fetch, run: run, saveWait: saveWait, keys: map[K]*cacheKey[V]{}, kept: map[K]bool{}}
	if persister != nil {
		c.attach(persister, unsaved)
	}
	return c
}

// attach has a cache that keeps nothing keep its values in persister from
// now on, telling refused each save the persister refuses. What persister
// kept is shown for each key the cache holds nothing of, and is asked for
// again the first time it is observed; a key the cache holds stands. Nothing
// is saved until a value changes.
func (c *Cache[K, V]) attach(persister CachePersister[K, V], refused func(error)) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	c.persister, c.refused = persister, refused
	for key, value := range persister.Load() {
		if _, held := c.keys[key]; held {
			continue
		}
		c.keys[key] = &cacheKey[V]{state: Ready[V]{Value: value}, changed: make(chan struct{})}
		c.kept[key] = true
	}
}

// held is the key's, made pending when the cache has none. Called with mu
// held.
func (c *Cache[K, V]) held(key K) *cacheKey[V] {
	k, ok := c.keys[key]
	if !ok {
		k = &cacheKey[V]{state: Pending{}, changed: make(chan struct{})}
		c.keys[key] = k
	}
	return k
}

// set makes state the key's, and tells its observers. Called with mu held.
func (k *cacheKey[V]) set(state CacheState) {
	k.state = state
	close(k.changed)
	k.changed = make(chan struct{})
}

// values is every key's value. Called with mu held.
func (c *Cache[K, V]) values() map[K]V {
	values := map[K]V{}
	for key, k := range c.keys {
		if ready, ok := k.state.(Ready[V]); ok {
			values[key] = ready.Value
		}
	}
	return values
}

// oweASave owes a save, and makes it once the values have stopped changing.
// While the save is being made nothing is owed, so the write it makes reads
// this cache as at rest; a save the persister refuses is owed again, and is
// made by the next change or by the cache's closing, never by a timer of its
// own. Close waits for a save being made, so it reads a refusal's owing. The
// refusal is told once the save is owed again, as the persister refused it.
// Called with mu held.
func (c *Cache[K, V]) oweASave() {
	if c.persister == nil {
		return
	}
	c.owed = true
	if c.saving != nil {
		c.saving.Stop()
	}
	persister, refused := c.persister, c.refused
	c.saving = time.AfterFunc(c.saveWait, func() {
		c.saves.Lock()
		defer c.saves.Unlock()
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		c.saving = nil
		c.owed = false
		values := c.values()
		c.mu.Unlock()
		if err := persister.Save(values); err != nil {
			// Close is waiting for saves, if it has begun: it has not yet read
			// what is owed.
			c.mu.Lock()
			c.owed = true
			c.mu.Unlock()
			refused(err)
		}
	})
}

// unsaved logs that a cache's values were not kept, for a client no session
// keeps for. Keeping them is a convenience: the cache goes on as it was, and
// the save stays owed.
func unsaved(err error) {
	slog.Warn("semiont: the cache's values were not kept", "error", err)
}

// fetching starts a fetch for key, or joins the one in flight. Called with mu
// held.
func (c *Cache[K, V]) fetching(key K) *flight[V] {
	// Asked for by this cache now, whichever path asked.
	delete(c.kept, key)
	k := c.held(key)
	if k.inFlight != nil {
		return k.inFlight
	}
	f := &flight[V]{done: make(chan struct{})}
	k.inFlight = f
	c.run(func(ctx context.Context) {
		value, err := c.fetch(ctx, key)
		c.mu.Lock()
		// Only the key's current flight acts on it, and its waiters are given
		// what it stores. One an Invalidate, a Set, a Remove or the closing
		// let go of answers its own waiters with its answer, and changes
		// nothing.
		if k, ok := c.keys[key]; ok && k.inFlight == f {
			k.inFlight = nil
			if err == nil {
				for _, change := range f.patches {
					value = change(value)
				}
				k.set(Ready[V]{Value: value})
				c.oweASave()
			} else if retried(err) {
				c.failed(key, k, f, err)
			}
		}
		c.mu.Unlock()
		f.value, f.err = value, err
		close(f.done)
	})
	return f
}

// awaited is what f came to, or ctx's end. A fetch the client's closing ended,
// while its caller still waited, failed as closed.
func awaited[V any](ctx context.Context, f *flight[V]) (V, error) {
	select {
	case <-f.done:
		if f.err != nil && errors.Is(f.err, context.Canceled) && ctx.Err() == nil {
			var none V
			return none, closedRead()
		}
		return f.value, f.err
	case <-ctx.Done():
		var none V
		return none, ctx.Err()
	}
}

// revalidate fetches for the live view: a failure is tried once more, and a
// key with no value whose retry also fails becomes Failed. Called with mu
// held.
func (c *Cache[K, V]) revalidate(key K) {
	c.fetching(key).asked = firstLiveAsk
}

// failed acts on the key in the step that settles its current flight f, which
// failed: the live view's first ask is asked once more at once, so the key is
// fetching from that failure until its retry settles; a second that failed
// fails a key with no value. The patches kept with f go with it: the retry is
// asked after their events arrived, so its answer holds them (B13b). Called
// with mu held.
func (c *Cache[K, V]) failed(key K, k *cacheKey[V], f *flight[V], err error) {
	switch f.asked {
	case firstLiveAsk:
		c.fetching(key).asked = retryLiveAsk
	case retryLiveAsk:
		if _, ready := k.state.(Ready[V]); !ready {
			k.set(Failed{Err: err})
		}
	}
}

// retried reports whether a failure of the live view's fetch is tried
// again: every failure but the client's closing, so no key is left pending
// with nothing in flight.
func retried(err error) bool {
	return err != nil && !errors.Is(err, context.Canceled)
}

// Observe is the key's state, now and as it changes, until the cache is
// closed or ctx is done. Observing is what asks, once the sequence is
// ranged over: a key with nothing is fetched, a failed key is tried again,
// and a value an earlier cache kept is asked for anew while it is shown.
func (c *Cache[K, V]) Observe(ctx context.Context, key K) iter.Seq[CacheState] {
	return func(yield func(CacheState) bool) {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		wasKept := c.kept[key]
		k := c.held(key)
		asks := false
		switch k.state.(type) {
		case Failed:
			// An observer arriving at a failed key starts over, for everyone: a fetch is in flight for all of them.
			k.set(Pending{})
			asks = true
		case Ready[V]:
			asks = wasKept
		default:
			asks = k.inFlight == nil
		}
		if asks {
			c.revalidate(key)
		}
		c.mu.Unlock()
		for {
			c.mu.Lock()
			state, changed, closed := k.state, k.changed, c.closed
			c.mu.Unlock()
			if closed || !yield(state) {
				return
			}
			select {
			case <-changed:
			case <-ctx.Done():
				return
			}
		}
	}
}

// Fetch asks for the key's value now: what the service answers, with the
// patches made meanwhile, which every observer of the key is given too unless
// an Invalidate, a Set or a Remove let go of the fetch first; or the failure,
// which only this caller is. Concurrent asks for one key share one fetch.
func (c *Cache[K, V]) Fetch(ctx context.Context, key K) (V, error) {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		var none V
		return none, closedRead()
	}
	f := c.fetching(key)
	c.mu.Unlock()
	return awaited(ctx, f)
}

// Get is the key's value now, asking for nothing; false when it has none.
func (c *Cache[K, V]) Get(key K) (V, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if k, ok := c.keys[key]; ok {
		if ready, ok := k.state.(Ready[V]); ok {
			return ready.Value, true
		}
	}
	var none V
	return none, false
}

// Known reports whether anything has asked for the key and not let go of it:
// it has a value or a failure, or a fetch for it is in flight.
func (c *Cache[K, V]) Known(key K) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	k, ok := c.keys[key]
	return ok && k.known()
}

// Keys is every key the cache knows.
func (c *Cache[K, V]) Keys() []K {
	c.mu.Lock()
	defer c.mu.Unlock()
	var keys []K
	for key, k := range c.keys {
		if k.known() {
			keys = append(keys, key)
		}
	}
	return keys
}

// PersistencePending reports whether a cache that keeps its values has not
// yet kept what it knows: a fetch is in flight, or a save is owed.
func (c *Cache[K, V]) PersistencePending() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.persister != nil && (c.owed || c.anyInFlight())
}

// keptFetching reports whether a cache that keeps its values has a fetch in
// flight.
func (c *Cache[K, V]) keptFetching() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.persister != nil && c.anyInFlight()
}

// anyInFlight reports whether a fetch is in flight; c.mu is held.
func (c *Cache[K, V]) anyInFlight() bool {
	for _, k := range c.keys {
		if k.inFlight != nil {
			return true
		}
	}
	return false
}

// Invalidate says the key's value is out of date: it is asked for again,
// shown meanwhile. A fetch already in flight is not waited on: its answer may
// never come, and when it does it goes to that fetch's own waiters alone.
func (c *Cache[K, V]) Invalidate(key K) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	k := c.held(key)
	k.inFlight = nil
	if _, failed := k.state.(Failed); failed {
		k.set(Pending{})
	}
	c.revalidate(key)
}

// InvalidateAll is Invalidate, of every key the cache knows.
func (c *Cache[K, V]) InvalidateAll() {
	for _, key := range c.Keys() {
		c.Invalidate(key)
	}
}

// Remove says the key's entity is gone: its value is dropped and the key is
// failed with gone, at once, for every observer. Nothing is asked for, and a
// fetch in flight is let go of: what it answers goes to its own waiters alone.
func (c *Cache[K, V]) Remove(key K, gone error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	k := c.held(key)
	k.inFlight = nil
	k.set(Failed{Err: gone})
	c.oweASave()
}

// Set makes value the key's, asking for nothing. A fetch in flight is let go
// of, as Remove lets it go (B13b): it was asked before the write, so its
// answer can be the value the write replaced. What it answers goes to its own
// waiters alone.
func (c *Cache[K, V]) Set(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	delete(c.kept, key)
	k := c.held(key)
	k.inFlight = nil
	k.set(Ready[V]{Value: value})
	c.oweASave()
}

// Patch writes part of the key's value: change takes the value to the patched
// one (B13b). It is applied to the value now, if the key has one. A fetch in
// flight can hold what the patch does not, so the patch lets go of nothing:
// it is kept with that fetch, and applied to its answer after those made
// before it. A key with neither a value nor a fetch in flight is left as it
// is (B20). A value an earlier cache kept stays one (B18): the rest of it is
// not known to be current. change is called with the cache's lock held, now
// and when the fetch answers, so it must not call the cache.
func (c *Cache[K, V]) Patch(key K, change func(V) V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	k, ok := c.keys[key]
	if !ok {
		return
	}
	if k.inFlight != nil {
		k.inFlight.patches = append(k.inFlight.patches, change)
	}
	if ready, isReady := k.state.(Ready[V]); isReady {
		k.set(Ready[V]{Value: change(ready.Value)})
		c.oweASave()
	}
}

// Close ends the cache: once a save being made has been answered, a save
// that is owed, a refused one among them, is made now, every observer's
// states end, and nothing is fetched or written after. Closing twice is
// closing once.
func (c *Cache[K, V]) Close() {
	c.saves.Lock()
	defer c.saves.Unlock()
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	if c.saving != nil {
		c.saving.Stop()
		c.saving = nil
	}
	var owed map[K]V
	if c.owed {
		c.owed = false
		owed = c.values()
	}
	persister, refused := c.persister, c.refused
	c.closed = true
	for _, k := range c.keys {
		close(k.changed)
	}
	clear(c.keys)
	clear(c.kept)
	c.mu.Unlock()
	if owed != nil {
		if err := persister.Save(owed); err != nil {
			// Lost: nothing is written after the closing.
			refused(err)
		}
	}
}
