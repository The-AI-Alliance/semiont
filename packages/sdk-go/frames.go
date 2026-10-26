package semiont

// What a transport delivers, and to whom: frames by channel, and the failures
// it met. Each listener has a queue of its own, and delivering to it never
// waits: a slow listener delays no other listener and no reply, and is given
// every item, in order.

import (
	"encoding/json"
	"iter"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Envelope is the routing beside a payload, never inside it: the correlation
// id that pairs a reply with its request, and the resource scope of a
// resource-bound broadcast.
type Envelope struct {
	// CorrelationID pairs a request with its reply; empty for a frame that is
	// neither.
	CorrelationID string
	// Scope is the resource whose scope the frame is broadcast on; the zero
	// ResourceId for a frame on no scope.
	Scope api.ResourceId
}

// Frame is a frame as a transport delivers it: its channel, its envelope, its
// payload, and the trace it was sent under. The payload carries no routing,
// and not the trace.
type Frame struct {
	Channel bus.Channel
	Envelope
	Payload json.RawMessage
	// Trace is the trace the work done for the frame continues (Continuing);
	// the zero TraceContext when it was sent under none.
	Trace TraceContext
}

// queue is one listener's: every item given to it, in order, however far
// behind its reader is.
type queue[T any] struct {
	mu     sync.Mutex
	items  []T
	closed bool
	// ready is signalled when an item is added or the queue closes.
	ready chan struct{}
}

func newQueue[T any]() *queue[T] {
	return &queue[T]{ready: make(chan struct{}, 1)}
}

func (q *queue[T]) signal() {
	select {
	case q.ready <- struct{}{}:
	default:
	}
}

// push adds item without waiting; false when the queue has closed.
func (q *queue[T]) push(item T) bool {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.closed {
		return false
	}
	q.items = append(q.items, item)
	q.signal()
	return true
}

// close ends the queue once its reader has taken what it holds.
func (q *queue[T]) close() {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.closed = true
	q.signal()
}

// next is the next item, waiting for one; false once the queue has closed and
// is empty.
func (q *queue[T]) next() (T, bool) {
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
		<-q.ready
	}
}

// all is what the queue is given, until it closes or the loop over it stops;
// leave is called once either happens.
func (q *queue[T]) all(leave func()) iter.Seq[T] {
	return func(yield func(T) bool) {
		defer leave()
		for {
			item, ok := q.next()
			if !ok || !yield(item) {
				return
			}
		}
	}
}

// broadcast gives each item to every queue listening when it is given.
type broadcast[T any] struct {
	mu        sync.Mutex
	listeners map[*queue[T]]struct{}
	closed    bool
}

func newBroadcast[T any]() *broadcast[T] {
	return &broadcast[T]{listeners: map[*queue[T]]struct{}{}}
}

// listen is a queue of what is given from now on; of a closed broadcast, one
// that has ended.
func (b *broadcast[T]) listen() *queue[T] {
	q := newQueue[T]()
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		q.close()
		return q
	}
	b.listeners[q] = struct{}{}
	return q
}

// leave stops q's listening and ends it.
func (b *broadcast[T]) leave(q *queue[T]) {
	b.mu.Lock()
	delete(b.listeners, q)
	b.mu.Unlock()
	q.close()
}

// give hands item to every listener; how many there were.
func (b *broadcast[T]) give(item T) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	for q := range b.listeners {
		q.push(item)
	}
	return len(b.listeners)
}

// close ends every listener's queue once it is read, and every later one at
// once.
func (b *broadcast[T]) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for q := range b.listeners {
		q.close()
	}
	clear(b.listeners)
}

// FrameHub is the frames of every channel anybody listens to, a broadcast per
// channel. What a transport delivers goes through one; so does what a test
// double of a transport delivers.
type FrameHub struct {
	mu       sync.Mutex
	channels map[bus.Channel]*broadcast[Frame]
	closed   bool
}

// NewFrameHub is a hub with no listener.
func NewFrameHub() *FrameHub {
	return &FrameHub{channels: map[bus.Channel]*broadcast[Frame]{}}
}

// Frames is the frames delivered on channel from now on: the listener is
// taken when frames is called, and let go when the loop over what it returns
// stops or the hub closes. Of a closed hub, a sequence that has ended.
func (h *FrameHub) Frames(channel bus.Channel) iter.Seq[Frame] {
	h.mu.Lock()
	b, ok := h.channels[channel]
	if !ok {
		b = newBroadcast[Frame]()
		if h.closed {
			b.close()
		} else {
			h.channels[channel] = b
		}
	}
	h.mu.Unlock()
	q := b.listen()
	return q.all(func() { b.leave(q) })
}

// Deliver hands frame to its channel's listeners.
func (h *FrameHub) Deliver(frame Frame) {
	h.mu.Lock()
	b, ok := h.channels[frame.Channel]
	h.mu.Unlock()
	if ok {
		b.give(frame)
	}
}

// Close ends every listener's sequence, and every one taken later.
func (h *FrameHub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.closed = true
	for _, b := range h.channels {
		b.close()
	}
}

// failureStream is the failures a transport met. Its first listener's queue is
// made with it and held until a listener takes it, because the stream opens
// before the transport's constructor returns: a failure reported before anyone
// has asked to hear failures is not lost to the first who does
// (docs/protocol/TRANSPORT-CONTRACT.md § Failures).
type failureStream struct {
	b     *broadcast[*TransportError]
	mu    sync.Mutex
	first *queue[*TransportError]
}

func newFailureStream() *failureStream {
	b := newBroadcast[*TransportError]()
	return &failureStream{b: b, first: b.listen()}
}

// failures is the failures reported from now on; for its first listener,
// every one since the stream was made.
func (f *failureStream) failures() iter.Seq[*TransportError] {
	f.mu.Lock()
	q := f.first
	f.first = nil
	f.mu.Unlock()
	if q == nil {
		q = f.b.listen()
	}
	return q.all(func() { f.b.leave(q) })
}

// report hands err to every listener, and returns it for its caller.
func (f *failureStream) report(err *TransportError) *TransportError {
	f.b.give(err)
	return err
}

func (f *failureStream) close() { f.b.close() }
