package registry

import (
	"context"
	"iter"
	"reflect"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
)

// held is a value the registry holds and anyone may watch, of a type Go
// cannot compare, such as a list. raise says every value it is given, even
// one equal to the last, so a reader told again reads it anew; set says only
// a value that differs.
type held[T any] struct {
	mu      sync.Mutex
	value   T
	version int
	ended   bool
	changed chan struct{}
}

var _ semiont.Watched[[]OpenResource] = (*held[[]OpenResource])(nil)

func newHeld[T any](value T) *held[T] {
	return &held[T]{value: value, changed: make(chan struct{})}
}

func (h *held[T]) Value() T {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.value
}

func (h *held[T]) raise(value T) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.put(value)
}

func (h *held[T]) set(value T) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !reflect.DeepEqual(h.value, value) {
		h.put(value)
	}
}

// put is raise, with the lock held.
func (h *held[T]) put(value T) {
	if h.ended {
		return
	}
	h.value = value
	h.version++
	close(h.changed)
	h.changed = make(chan struct{})
}

func (h *held[T]) end() {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.ended {
		return
	}
	h.ended = true
	close(h.changed)
}

func (h *held[T]) Changes(ctx context.Context) iter.Seq[T] {
	return func(yield func(T) bool) {
		h.mu.Lock()
		value, seen, changed := h.value, h.version, h.changed
		h.mu.Unlock()
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
				h.mu.Lock()
				value, changed = h.value, h.changed
				version, ended := h.version, h.ended
				h.mu.Unlock()
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
