package semiont

// A live query: one of a client's reads that answers from its cache and stays
// true as the knowledge base changes.

import (
	"context"
	"iter"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
)

// Cached is a live query. Building it touches nothing, so a query is made
// wherever it is convenient to name it. It is then read one of two ways:
//
//   - ranged over (States), it is the live view: the query's state now, and
//     each state after it, until the client is closed or the loop stops.
//     Watching is what asks: the first watcher of a query nobody has asked
//     starts its fetch. While a query of one resource is watched, the client
//     holds that resource's scope, so the events that keep the query true
//     reach it. A failure is a state (Failed), never the end of the loop.
//   - Fresh is the one-shot read: it asks the service now, and gives what it
//     answers or the failure it met. Every watcher of the query is given the
//     answer too.
//
// Invalidate says the value is out of date: it is asked for again, and shown
// meanwhile. A value is the one every reader of the query is given: it is
// read, not changed.
type Cached[T any] struct {
	fresh      func(ctx context.Context) (T, error)
	watch      func(ctx context.Context) iter.Seq[CacheState]
	invalidate func()
	// hold takes the scope of the resource the query is of, and gives what
	// lets it go; nil for a query of no resource.
	hold func() (release func())
}

// Fresh asks the service now, and gives what it answers.
func (q *Cached[T]) Fresh(ctx context.Context) (T, error) {
	return q.fresh(ctx)
}

// States is the query's state now and each state after it: Pending,
// Ready[T] or Failed, until ctx is done, the loop stops, or the client
// closes. An observer that falls behind is given the latest state.
func (q *Cached[T]) States(ctx context.Context) iter.Seq[CacheState] {
	return func(yield func(CacheState) bool) {
		// The scope first, so the events that refresh the key are already coming when its value arrives.
		if q.hold != nil {
			release := q.hold()
			defer release()
		}
		for state := range q.watch(ctx) {
			if !yield(state) {
				return
			}
		}
	}
}

// Invalidate says the value is out of date: it is asked for again, and shown
// meanwhile.
func (q *Cached[T]) Invalidate() {
	q.invalidate()
}

// shown is a state of a cache's value V, as a state of what a query shows of
// it.
func shown[V, T any](state CacheState, view func(V) T) CacheState {
	if ready, ok := state.(Ready[V]); ok {
		return Ready[T]{Value: view(ready.Value)}
	}
	return state
}

// itself is a value as it is: the view of a query that shows its cache's
// value whole.
func itself[V any](value V) V { return value }

// keyed is the query answered by key of c, as view shows its value. scope,
// when it is not the zero ResourceId, is the resource the query is of, whose
// scope is held while the query is watched.
func keyed[K comparable, V, T any](l *links, c *Cache[K, V], key K, view func(V) T, scope api.ResourceId) *Cached[T] {
	q := &Cached[T]{
		fresh: func(ctx context.Context) (T, error) {
			value, err := c.Fetch(ctx, key)
			if err != nil {
				var none T
				return none, err
			}
			return view(value), nil
		},
		watch: func(ctx context.Context) iter.Seq[CacheState] {
			return func(yield func(CacheState) bool) {
				for state := range c.Observe(ctx, key) {
					if !yield(shown(state, view)) {
						return
					}
				}
			}
		},
		invalidate: func() { c.Invalidate(key) },
	}
	if !scope.IsZero() {
		q.hold = func() func() { return l.transport.SubscribeToResource(scope) }
	}
	return q
}
