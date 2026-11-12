// Package kept is what a stream keeps for its readers: for each reader, every
// item given to it, in order, however far behind it falls (Queue, Broadcast);
// and for a reader who has not come yet, the latest
// errorsKeptForFirstReaderCount (protocol/specs/src/client/timing.json) of
// what it said, the oldest dropped beyond them (Stream, Telling).
package kept

import (
	"slices"
	"sync"
)

// latest is the last n of items; those before them are cleared, so that
// nothing is held by them.
func latest[T any](items []T, n int) []T {
	beyond := len(items) - n
	if beyond <= 0 {
		return items
	}
	clear(items[:beyond])
	return items[beyond:]
}

// Telling is what a stream reports, each told to every listener within its
// report, before the call that reported it returns, and all under one lock,
// so each listener is told them in the order they were reported. Of what is
// reported before anyone listens, the latest keptForFirst are kept for the
// first listener, until the stream closes, and told to it as it starts
// listening. A transport's failures are told so, because the transport opens
// before whatever listens to it is returned to its caller, and each failure
// is told as it is thrown to its caller (protocol/contract/TRANSPORT-CONTRACT.md
// § Failures), where a Stream's readers each take what it reports at their
// own pace.
type Telling[T any] struct {
	mu        sync.Mutex
	listeners []*listener[T]
	// heard holds once anyone has listened: nothing is kept after that.
	heard bool
	// kept is the latest keptForFirst reported before anyone listened.
	kept         []T
	keptForFirst int
	closed       bool
}

// listener is one listener of a Telling.
type listener[T any] struct{ told func(T) }

// NewTelling is a Telling nobody listens to, which keeps the latest
// keptForFirst of what it reports for its first listener.
func NewTelling[T any](keptForFirst int) *Telling[T] {
	return &Telling[T]{keptForFirst: keptForFirst}
}

// Listen tells told each item reported from now on; the first listener is
// told first the latest keptForFirst reported since the Telling was made.
// stop ends the telling: once it returns, a telling under way has ended and
// nothing more is told. Stopping twice is stopping once.
func (t *Telling[T]) Listen(told func(T)) (stop func()) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.heard {
		t.heard = true
		for _, item := range t.kept {
			told(item)
		}
		t.kept = nil
	}
	l := &listener[T]{told: told}
	if !t.closed {
		t.listeners = append(t.listeners, l)
	}
	return func() {
		t.mu.Lock()
		defer t.mu.Unlock()
		t.listeners = slices.DeleteFunc(t.listeners, func(each *listener[T]) bool { return each == l })
	}
}

// Report tells item to every listener, or keeps it for the first, the oldest
// kept dropped beyond keptForFirst, and returns it for its caller. Once the
// Telling has closed, it is told nowhere.
func (t *Telling[T]) Report(item T) T {
	t.mu.Lock()
	defer t.mu.Unlock()
	switch {
	case t.closed:
	case !t.heard:
		t.kept = latest(append(t.kept, item), t.keptForFirst)
	default:
		for _, l := range t.listeners {
			l.told(item)
		}
	}
	return item
}

// Close ends every listener's telling: nothing more is told, or kept, and
// what was kept for a first listener who has not come is let go of.
func (t *Telling[T]) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.closed = true
	t.listeners = nil
	t.kept = nil
}
