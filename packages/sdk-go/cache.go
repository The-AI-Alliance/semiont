package semiont

// A read-through cache: what a client's live queries answer from
// (docs/protocol/CACHE-SEMANTICS.md, B1 to B20).

import (
	"context"
	"errors"
	"iter"
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
	// Save keeps entries: the cache's values, after they changed.
	Save(entries map[K]V)
}

// closedRead is what a read of a closed client fails as: what a request of
// a closed bus does.
func closedRead() error {
	return &BusRequestError{Code: BusRequestErrorCodeClosed, Message: "The client is closed"}
}

// flight is a fetch in flight for a key: its number, and what it came to
// once done is closed.
type flight[V any] struct {
	number int
	done   chan struct{}
	value  V
	err    error
}

// cacheKey is one key's: its state, and the fetch in flight for it.
type cacheKey[V any] struct {
	state CacheState
	// changed is closed when the state changes, and replaced.
	changed  chan struct{}
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
// saveWait after they last changed. A value that was kept is shown at once and
// asked for again the first time it is observed: nothing says it is still
// true. An observer that falls behind is given the latest state, not each one
// it missed.
type Cache[K comparable, V any] struct {
	fetch     func(ctx context.Context, key K) (V, error)
	run       func(work func(ctx context.Context))
	persister CachePersister[K, V]
	saveWait  time.Duration

	mu      sync.Mutex
	keys    map[K]*cacheKey[V]
	kept    map[K]bool
	fetches int
	saving  *time.Timer
	closed  bool
}

var _ StateUnit = (*Cache[string, string])(nil)

// NewCache is a cache whose fetches run by run and ask fetch. With a
// persister, it begins with what that kept, and saves to it saveWait after
// its values last changed; persister is nil for a cache that keeps nothing.
func NewCache[K comparable, V any](fetch func(ctx context.Context, key K) (V, error), run func(work func(ctx context.Context)), persister CachePersister[K, V], saveWait time.Duration) *Cache[K, V] {
	c := &Cache[K, V]{fetch: fetch, run: run, persister: persister, saveWait: saveWait, keys: map[K]*cacheKey[V]{}, kept: map[K]bool{}}
	if persister != nil {
		for key, value := range persister.Load() {
			c.keys[key] = &cacheKey[V]{state: Ready[V]{Value: value}, changed: make(chan struct{})}
			c.kept[key] = true
		}
	}
	return c
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

// oweASave saves the values once they have stopped changing. Called with mu
// held.
func (c *Cache[K, V]) oweASave() {
	if c.persister == nil {
		return
	}
	if c.saving != nil {
		c.saving.Stop()
	}
	c.saving = time.AfterFunc(c.saveWait, func() {
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		c.saving = nil
		values := c.values()
		c.mu.Unlock()
		c.persister.Save(values)
	})
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
	c.fetches++
	f := &flight[V]{number: c.fetches, done: make(chan struct{})}
	k.inFlight = f
	c.run(func(ctx context.Context) {
		value, err := c.fetch(ctx, key)
		c.mu.Lock()
		// Only its own: an invalidate may have put a newer fetch in its place.
		if k, ok := c.keys[key]; ok && k.inFlight == f {
			k.inFlight = nil
		}
		// A value from any fetch is written, the newest last: each is at
		// least as new as what was there. A failure writes nothing. One
		// answered after the cache was closed has no key to write to.
		if err == nil {
			if k, ok := c.keys[key]; ok {
				k.set(Ready[V]{Value: value})
				c.oweASave()
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
	first := c.fetching(key)
	c.run(func(ctx context.Context) {
		if _, err := awaited(ctx, first); !retried(err) {
			return
		}
		c.mu.Lock()
		if c.closed {
			c.mu.Unlock()
			return
		}
		second := c.fetching(key)
		c.mu.Unlock()
		_, err := awaited(ctx, second)
		if !retried(err) {
			return
		}
		c.mu.Lock()
		defer c.mu.Unlock()
		if k, ok := c.keys[key]; ok && !c.closed {
			if _, ready := k.state.(Ready[V]); !ready {
				k.set(Failed{Err: err})
			}
		}
	})
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

// Fetch asks for the key's value now: what the service answers, which
// every observer of the key is given too; or the failure, which only this
// caller is. Concurrent asks for one key share one fetch.
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
	if c.persister == nil {
		return false
	}
	if c.saving != nil {
		return true
	}
	for _, k := range c.keys {
		if k.inFlight != nil {
			return true
		}
	}
	return false
}

// Invalidate says the key's value is out of date: it is asked for again,
// shown meanwhile. A fetch already in flight is not waited on: its answer may
// never come.
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
// failed with gone, at once, for every observer. Nothing is asked for.
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

// Set makes value the key's, asking for nothing.
func (c *Cache[K, V]) Set(key K, value V) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return
	}
	delete(c.kept, key)
	c.held(key).set(Ready[V]{Value: value})
	c.oweASave()
}

// Close ends the cache: a save that was owed is made now, every
// observer's states end, and nothing is fetched or written after. Closing
// twice is closing once.
func (c *Cache[K, V]) Close() {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return
	}
	var owed map[K]V
	if c.saving != nil {
		c.saving.Stop()
		c.saving = nil
		owed = c.values()
	}
	c.closed = true
	for _, k := range c.keys {
		close(k.changed)
	}
	clear(c.keys)
	clear(c.kept)
	c.mu.Unlock()
	if owed != nil {
		c.persister.Save(owed)
	}
}
