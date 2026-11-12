package semionttest

import (
	"slices"
	"sync"
)

// stream tells each item to every listener listening when it is given,
// within the giving, and all under one lock, so each listener is told them in
// the order they were given. It tells nothing once it has closed.
type stream[T any] struct {
	mu        sync.Mutex
	listeners []*listener[T]
	closed    bool
}

func newStream[T any]() *stream[T] { return &stream[T]{} }

// listener is one listener of a stream.
type listener[T any] struct{ told func(T) }

// listen tells told each item given from now on, until stop or the stream
// closes. Once stop returns, a telling under way has ended and nothing more
// is told. Stopping twice is stopping once.
func (s *stream[T]) listen(told func(T)) (stop func()) {
	l := &listener[T]{told: told}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.closed {
		s.listeners = append(s.listeners, l)
	}
	return func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.listeners = slices.DeleteFunc(s.listeners, func(each *listener[T]) bool { return each == l })
	}
}

func (s *stream[T]) give(item T) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.listeners {
		l.told(item)
	}
}

func (s *stream[T]) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	s.listeners = nil
}
