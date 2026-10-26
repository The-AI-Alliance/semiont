package semiont

import (
	"context"
	"iter"
	"sync"
)

// ConnectionState is whether the bus can deliver, as a transport reports it
// (docs/protocol/TRANSPORT-CONTRACT.md § State).
type ConnectionState string

const (
	// ConnectionStateInitial is before the transport has started its stream.
	ConnectionStateInitial ConnectionState = "initial"
	// ConnectionStateConnecting is a connect in flight with no stream live.
	ConnectionStateConnecting ConnectionState = "connecting"
	// ConnectionStateOpen is a stream live. It is left only when the stream
	// drops: a transport that changes what its stream carries without missing
	// anything stays open, so open reached again always means something may
	// have been missed.
	ConnectionStateOpen ConnectionState = "open"
	// ConnectionStateReconnecting is a stream that dropped, or a connect that
	// failed with none live, being tried again.
	ConnectionStateReconnecting ConnectionState = "reconnecting"
	// ConnectionStateDegraded is reconnecting for longer than
	// Timing.DegradedThreshold.
	ConnectionStateDegraded ConnectionState = "degraded"
	// ConnectionStateUnauthenticated is not attempting: there is no
	// credential, or the one there is was refused. It ends when a different
	// credential appears.
	ConnectionStateUnauthenticated ConnectionState = "unauthenticated"
	// ConnectionStateClosed is the transport closed. Terminal.
	ConnectionStateClosed ConnectionState = "closed"
)

// allowed reports whether the connection's state may move from one state to
// another (docs/protocol/TRANSPORT-HTTP.md § Connection lifecycle).
func allowed(from, to ConnectionState) bool {
	switch from {
	case ConnectionStateInitial:
		return to == ConnectionStateConnecting || to == ConnectionStateUnauthenticated || to == ConnectionStateClosed
	case ConnectionStateConnecting:
		return to == ConnectionStateOpen || to == ConnectionStateReconnecting || to == ConnectionStateUnauthenticated || to == ConnectionStateClosed
	case ConnectionStateOpen:
		return to == ConnectionStateReconnecting || to == ConnectionStateClosed
	case ConnectionStateReconnecting:
		return to == ConnectionStateConnecting || to == ConnectionStateDegraded || to == ConnectionStateUnauthenticated || to == ConnectionStateClosed
	case ConnectionStateDegraded:
		return to == ConnectionStateConnecting || to == ConnectionStateUnauthenticated || to == ConnectionStateClosed
	case ConnectionStateUnauthenticated:
		return to == ConnectionStateConnecting || to == ConnectionStateClosed
	default:
		return false
	}
}

// Watched is a value that changes: what it is now, and what it becomes. A
// reader is given the present value at once and then each change; one that
// falls behind is given the latest value in place of the ones it missed,
// because a state is what is true now.
type Watched[T comparable] struct {
	mu    sync.Mutex
	value T
	// changed is closed when value next changes, and then replaced.
	changed chan struct{}
}

// NewWatched is a Watched whose value is value.
func NewWatched[T comparable](value T) *Watched[T] {
	return &Watched[T]{value: value, changed: make(chan struct{})}
}

// Value is the value now.
func (w *Watched[T]) Value() T {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.value
}

// Set makes value the value. Setting the value it already has changes
// nothing.
func (w *Watched[T]) Set(value T) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.value == value {
		return
	}
	w.value = value
	close(w.changed)
	w.changed = make(chan struct{})
}

// watch is the value now, and a channel closed when it next changes.
func (w *Watched[T]) watch() (T, <-chan struct{}) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.value, w.changed
}

// Changes is the value now and each value it becomes, until ctx is done or
// the loop over it stops.
func (w *Watched[T]) Changes(ctx context.Context) iter.Seq[T] {
	return func(yield func(T) bool) {
		value, changed := w.watch()
		for {
			if !yield(value) {
				return
			}
			select {
			case <-ctx.Done():
				return
			case <-changed:
			}
			value, changed = w.watch()
		}
	}
}
