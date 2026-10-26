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

// Watched is what a reader of a changing value holds: its value now, and
// each value it becomes. A reader is given the present value at once and then
// each change; one that falls behind is given the latest value in place of
// the ones it missed, because a state is what is true now. Its changes end
// when the value can change no more.
type Watched[T any] interface {
	// Value is the value now.
	Value() T
	// Changes is the value now and each value it becomes, until the value
	// can change no more, ctx is done, or the loop over it stops.
	Changes(ctx context.Context) iter.Seq[T]
}

// Variable is a value its owner changes, and anyone may watch.
type Variable[T comparable] struct {
	mu    sync.Mutex
	value T
	// version counts the changes, so a reader knows which it has been given.
	version int
	ended   bool
	// changed is closed when value next changes, and then replaced; closed
	// for good when the variable ends.
	changed chan struct{}
}

var _ Watched[int] = (*Variable[int])(nil)

// NewVariable is a Variable whose value is value.
func NewVariable[T comparable](value T) *Variable[T] {
	return &Variable[T]{value: value, changed: make(chan struct{})}
}

// Value is the value now.
func (v *Variable[T]) Value() T {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.value
}

// Set makes value the value. Setting the value it already has changes
// nothing, and after End nothing does.
func (v *Variable[T]) Set(value T) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.ended || v.value == value {
		return
	}
	v.value = value
	v.version++
	close(v.changed)
	v.changed = make(chan struct{})
}

// End says the value will not change again: each reader's changes end once
// it has been given this one. Ending twice is ending once.
func (v *Variable[T]) End() {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.ended {
		return
	}
	v.ended = true
	close(v.changed)
}

// watch is the value now, and a channel closed when it next changes: nil
// once it has ended, since it will not change again.
func (v *Variable[T]) watch() (T, <-chan struct{}) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.ended {
		return v.value, nil
	}
	return v.value, v.changed
}

func (v *Variable[T]) Changes(ctx context.Context) iter.Seq[T] {
	return func(yield func(T) bool) {
		v.mu.Lock()
		value, seen, changed := v.value, v.version, v.changed
		v.mu.Unlock()
		for {
			if !yield(value) {
				return
			}
			for {
				select {
				case <-ctx.Done():
					return
				case <-changed:
				}
				v.mu.Lock()
				value, changed = v.value, v.changed
				version, ended := v.version, v.ended
				v.mu.Unlock()
				if version != seen {
					seen = version
					break
				}
				if ended {
					return
				}
			}
		}
	}
}
