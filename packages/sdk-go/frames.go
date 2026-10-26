package semiont

// What a transport delivers, and to whom: frames by channel, and the failures
// it met. Each listener has a queue of its own, and delivering to it never
// waits: a slow listener delays no other listener and no reply, and is given
// every item, in order.

import (
	"encoding/json"
	"iter"
	"slices"
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
// is empty, or stop is closed first. A nil stop never is.
func (q *queue[T]) next(stop <-chan struct{}) (T, bool) {
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

// drain takes every item the queue holds now, without waiting; closed is
// whether the queue has closed and nothing more will come. A reader that
// selects on ready drains after each signal.
func (q *queue[T]) drain() (items []T, closed bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	items, q.items = q.items, nil
	return items, q.closed
}

// all is what the queue is given, until it closes, stop is closed, or the
// loop over it stops; leave is called once any of them happens. A nil stop is
// never closed: the loop is ended by its reader.
func (q *queue[T]) all(stop <-chan struct{}, leave func()) iter.Seq[T] {
	return func(yield func(T) bool) {
		defer leave()
		for {
			item, ok := q.next(stop)
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
	b.join(q)
	return q
}

// join makes q a listener: it is given what is given from now on. Joining a
// closed broadcast ends q.
func (b *broadcast[T]) join(q *queue[T]) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.closed {
		q.close()
		return
	}
	b.listeners[q] = struct{}{}
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

// FrameSink is where a transport delivers every frame it receives: its
// client's own bus.
type FrameSink interface {
	// Deliver takes one frame, as the transport delivered it.
	Deliver(frame Frame)
}

// FrameHub is the frames of every channel anybody listens to, a broadcast per
// channel, and the buses every frame is bridged into. What a transport
// delivers goes through one; so does what a test double of a transport
// delivers.
type FrameHub struct {
	mu       sync.Mutex
	channels map[bus.Channel]*broadcast[Frame]
	bridged  []FrameSink
	closed   bool
}

// NewFrameHub is a hub with no listener.
func NewFrameHub() *FrameHub {
	return &FrameHub{channels: map[bus.Channel]*broadcast[Frame]{}}
}

// Frames is the frames delivered on any of channels from now on, in the order
// they were delivered: one listener, taken when Frames is called, and let go
// when the loop over what it returns stops or the hub closes. Of a closed hub,
// a sequence that has ended.
func (h *FrameHub) Frames(channels ...bus.Channel) iter.Seq[Frame] {
	q := newQueue[Frame]()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		q.close()
		return q.all(nil, func() {})
	}
	joined := make([]*broadcast[Frame], 0, len(channels))
	for _, channel := range channels {
		b, ok := h.channels[channel]
		if !ok {
			b = newBroadcast[Frame]()
			h.channels[channel] = b
		}
		b.join(q)
		joined = append(joined, b)
	}
	return q.all(nil, func() {
		for _, b := range joined {
			b.leave(q)
		}
	})
}

// Bridge delivers into sink every frame delivered here from now on, whatever
// its channel. Each is published to everyone there, whichever scope it came
// on: a client's bus keeps its scopes for what the client's own parts say to
// each other. Of a closed hub, nothing.
func (h *FrameHub) Bridge(sink FrameSink) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if !h.closed {
		h.bridged = append(h.bridged, sink)
	}
}

// Deliver hands frame to every bus bridged into, and to its channel's
// listeners.
func (h *FrameHub) Deliver(frame Frame) {
	h.mu.Lock()
	bridged := slices.Clone(h.bridged)
	b, ok := h.channels[frame.Channel]
	h.mu.Unlock()
	everyone := frame
	everyone.Scope = api.ResourceId{}
	for _, sink := range bridged {
		sink.Deliver(everyone)
	}
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
	h.bridged = nil
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
	return q.all(nil, func() { f.b.leave(q) })
}

// report hands err to every listener, and returns it for its caller.
func (f *failureStream) report(err *TransportError) *TransportError {
	f.b.give(err)
	return err
}

func (f *failureStream) close() { f.b.close() }
