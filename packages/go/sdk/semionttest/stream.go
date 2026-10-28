package semionttest

import (
	"iter"
	"sync"
)

// stream gives each item to every listener listening when it is given, and
// ends every listener when it closes. Each listener is given every item, in
// order, however far behind its reader is.
type stream[T any] struct {
	mu        sync.Mutex
	listeners []*listener[T]
	closed    bool
}

func newStream[T any]() *stream[T] { return &stream[T]{} }

// listener is one reader's items: what it was given and has not taken.
type listener[T any] struct {
	mu     sync.Mutex
	items  []T
	closed bool
	// ready is signalled when an item is given or the listener closes.
	ready chan struct{}
}

func (l *listener[T]) signal() {
	select {
	case l.ready <- struct{}{}:
	default:
	}
}

// listen is the items given from now on, until the stream closes or the loop
// over them stops. The listener is taken now, not when it is ranged over.
func (s *stream[T]) listen() iter.Seq[T] {
	l := &listener[T]{ready: make(chan struct{}, 1)}
	s.mu.Lock()
	if s.closed {
		l.closed = true
	} else {
		s.listeners = append(s.listeners, l)
	}
	s.mu.Unlock()
	return func(yield func(T) bool) {
		defer s.leave(l)
		for {
			l.mu.Lock()
			if len(l.items) > 0 {
				item := l.items[0]
				l.items = l.items[1:]
				l.mu.Unlock()
				if !yield(item) {
					return
				}
				continue
			}
			closed := l.closed
			l.mu.Unlock()
			if closed {
				return
			}
			<-l.ready
		}
	}
}

func (s *stream[T]) leave(l *listener[T]) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i, each := range s.listeners {
		if each == l {
			s.listeners = append(s.listeners[:i], s.listeners[i+1:]...)
			return
		}
	}
}

func (s *stream[T]) give(item T) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.listeners {
		l.mu.Lock()
		l.items = append(l.items, item)
		l.signal()
		l.mu.Unlock()
	}
}

func (s *stream[T]) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, l := range s.listeners {
		l.mu.Lock()
		l.closed = true
		l.signal()
		l.mu.Unlock()
	}
	s.listeners = nil
}
