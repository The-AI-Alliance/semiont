package kept

import (
	"iter"
	"sync"
)

// Stream is what a session, a worker's claims or a registry say went wrong,
// each reader given every item from when it reads, in order, however far
// behind it falls, at its own pace: reporting never waits for a reader. Its
// first reader's queue is made with it and held until a reader takes it or
// the stream closes, because the stream opens before whatever reads it is
// handed what says it: the first who reads is given first the latest
// keptForFirst of what was reported before.
type Stream[T any] struct {
	b     *Broadcast[T]
	mu    sync.Mutex
	first *Queue[T]
	// keptForFirst is how many the first reader's queue holds while it is
	// held: the latest, the oldest dropped beyond them.
	keptForFirst int
}

// NewStream is a stream nobody reads, which keeps the latest keptForFirst of
// what it reports for its first reader.
func NewStream[T any](keptForFirst int) *Stream[T] {
	b := NewBroadcast[T]()
	return &Stream[T]{b: b, first: b.Listen(), keptForFirst: keptForFirst}
}

// Reported is what is reported from now on, until the stream closes, stop is
// closed or the loop over it stops; its first reader is given first the
// latest keptForFirst reported since the stream was made. A nil stop is never
// closed. Once the stream has closed, every reader is given only its end.
func (s *Stream[T]) Reported(stop <-chan struct{}) iter.Seq[T] {
	s.mu.Lock()
	q := s.first
	s.first = nil
	s.mu.Unlock()
	if q == nil {
		q = s.b.Listen()
	}
	return q.All(stop, func() { s.b.Leave(q) })
}

// Report hands item to every reader, and returns it for its caller. While
// the first reader's queue is held, the oldest it holds beyond keptForFirst
// is dropped, under the lock it is handed over under, so its reader is given
// no more.
func (s *Stream[T]) Report(item T) T {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.b.Give(item)
	if s.first != nil {
		s.first.KeepLatest(s.keptForFirst)
	}
	return item
}

// Close ends every reader's items once it has read what it holds. What was
// kept for a first reader who has not come is let go of.
func (s *Stream[T]) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.first = nil
	s.b.Close()
}
