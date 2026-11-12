package kept

import (
	"iter"
	"sync"
)

// Queue is one reader's: every item given to it, in order, however far
// behind its reader is.
type Queue[T any] struct {
	mu     sync.Mutex
	items  []T
	closed bool
	// ready is signalled when an item is added or the queue closes.
	ready chan struct{}
}

// NewQueue is a queue that holds nothing.
func NewQueue[T any]() *Queue[T] {
	return &Queue[T]{ready: make(chan struct{}, 1)}
}

// Signal signals Ready, as an item added does: a reader that has drained and
// handled what a closed queue held is woken on its next turn to drain the end.
func (q *Queue[T]) Signal() {
	select {
	case q.ready <- struct{}{}:
	default:
	}
}

// Push adds item without waiting; once the queue has closed, it is added
// nowhere.
func (q *Queue[T]) Push(item T) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return
	}
	q.items = append(q.items, item)
	q.Signal()
}

// Close ends the queue once its reader has taken what it holds.
func (q *Queue[T]) Close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.closed = true
	q.Signal()
}

// Next is the next item, waiting for one; false once the queue has closed and
// is empty, or stop is closed first. A nil stop never is.
func (q *Queue[T]) Next(stop <-chan struct{}) (T, bool) {
	for {
		q.mu.Lock()
		if len(q.items) > 0 {
			item := q.items[0]
			var zero T
			q.items[0] = zero
			q.items = q.items[1:]
			q.mu.Unlock()
			return item, true
		}
		if q.closed {
			q.mu.Unlock()
			var zero T
			return zero, false
		}
		q.mu.Unlock()
		select {
		case <-q.ready:
		case <-stop:
			var zero T
			return zero, false
		}
	}
}

// KeepLatest drops the oldest items the queue holds beyond n.
func (q *Queue[T]) KeepLatest(n int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = latest(q.items, n)
}

// Ready is signalled when an item is added or the queue closes. A reader that
// selects on it drains after each signal.
func (q *Queue[T]) Ready() <-chan struct{} { return q.ready }

// Drain takes every item the queue holds now, without waiting; closed is
// whether the queue has closed and nothing more will come.
func (q *Queue[T]) Drain() (items []T, closed bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	items, q.items = q.items, nil
	return items, q.closed
}

// All is what the queue is given, until it closes, stop is closed, or the
// loop over it stops; leave is called once any of them happens. A nil stop is
// never closed: the loop is ended by its reader.
func (q *Queue[T]) All(stop <-chan struct{}, leave func()) iter.Seq[T] {
	return func(yield func(T) bool) {
		defer leave()
		for {
			item, ok := q.Next(stop)
			if !ok || !yield(item) {
				return
			}
		}
	}
}

// Broadcast gives each item to every queue listening when it is given.
type Broadcast[T any] struct {
	mu        sync.Mutex
	listeners map[*Queue[T]]struct{}
	closed    bool
}

// NewBroadcast is a broadcast nobody listens to.
func NewBroadcast[T any]() *Broadcast[T] {
	return &Broadcast[T]{listeners: map[*Queue[T]]struct{}{}}
}

// Listen is a queue of what is given from now on; of a closed broadcast, one
// that has ended.
func (b *Broadcast[T]) Listen() *Queue[T] {
	q := NewQueue[T]()
	b.Join(q)
	return q
}

// Join makes q a listener: it is given what is given from now on. Joining a
// closed broadcast ends q.
func (b *Broadcast[T]) Join(q *Queue[T]) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		q.Close()
		return
	}
	b.listeners[q] = struct{}{}
}

// Leave stops q's listening and ends it.
func (b *Broadcast[T]) Leave(q *Queue[T]) {
	b.mu.Lock()
	delete(b.listeners, q)
	b.mu.Unlock()
	q.Close()
}

// Give hands item to every listener; how many there were.
func (b *Broadcast[T]) Give(item T) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	for q := range b.listeners {
		q.Push(item)
	}
	return len(b.listeners)
}

// Close ends every listener's queue once it is read, and every later one at
// once.
func (b *Broadcast[T]) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for q := range b.listeners {
		q.Close()
	}
	clear(b.listeners)
}
