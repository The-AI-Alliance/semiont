package semiont

// What a transport delivers, and to whom: frames by channel, and the failures
// it met. Each listener of frames, and of what a session says went wrong, has
// a queue of its own, and delivering to it never waits: a slow listener delays
// no other listener and no reply, and is given every item, in order. Each
// failure a transport meets is told to its listeners within its report.

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"slices"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
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
	// place is the place a recorded event delivered on its scope reaches,
	// kept when the frame is bridged into a client's bus for everyone; the
	// zero eventPlace for any other frame.
	place eventPlace
}

// eventPlace is a scope's place: the scope a recorded event was delivered
// on, and the event's id, a PersistedEventId.
type eventPlace struct {
	scope api.ResourceId
	id    string
}

// FrameRefusal is what a channel's readers are given in place of a frame
// refused for its first fault: by its transport, as one BusFrame does not
// allow whose channel and scope name its readers, or by its channel's typed
// reader, as one whose payload is not its channel's.
type FrameRefusal struct {
	// Channel is the channel the frame names.
	Channel bus.Channel
	// Member is the way from the frame to its first fault: the names of the
	// members it is within, and its own, joined by dots. A fault of the
	// frame's payload is within `payload`.
	Member string
	// Reason is why the frame is refused at Member.
	Reason bus.FrameRefusalReason
	// Payload is the frame's payload as it came; nil when it carried none.
	Payload json.RawMessage
	// Envelope is the scope the frame names, and its correlation id when it
	// carries one BusFrame allows: empty when its correlation id cannot be
	// read. A request awaiting the reply that correlation id names is told
	// of the refusal (ReplyRouter.RouteRefusal).
	Envelope
}

// Error is what every SDK says of a frame its channel's reader is given a
// refusal of.
func (r *FrameRefusal) Error() string {
	return fmt.Sprintf("a frame on %s is not that channel's: %s", r.Channel, required.Fault{Member: r.Member, Reason: r.Reason})
}

// arrival is what a channel's readers are given: a frame, or the refusal of
// one in its place.
type arrival struct {
	frame   Frame
	refusal *FrameRefusal
}

// told is the arrival as a sequence of frames gives it: the frame and no
// error, or the channel and envelope the refused frame names, with its
// refusal as the error.
func (a arrival) told() (Frame, error) {
	if a.refusal != nil {
		return Frame{Channel: a.refusal.Channel, Envelope: a.refusal.Envelope}, a.refusal
	}
	return a.frame, nil
}

// toldFrames is arrivals, each as told gives it.
func toldFrames(arrivals iter.Seq[arrival]) iter.Seq2[Frame, error] {
	return func(yield func(Frame, error) bool) {
		for one := range arrivals {
			if !yield(one.told()) {
				return
			}
		}
	}
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

// keepLatest drops the oldest items the queue holds beyond n.
func (q *queue[T]) keepLatest(n int) {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.items = latest(q.items, n)
}

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

// FrameSink is where a transport delivers every frame it receives, and the
// refusal of each frame it refuses that names its readers: its client's own
// bus.
type FrameSink interface {
	// Deliver takes one frame, as the transport delivered it.
	Deliver(frame Frame)
	// DeliverRefusal takes the refusal of one frame, in its place.
	DeliverRefusal(refusal *FrameRefusal)
}

// FrameHub is the frames of every channel anybody listens to, a broadcast per
// channel, and the buses every frame is bridged into. What a transport
// delivers goes through one; so does what a test double of a transport
// delivers.
type FrameHub struct {
	mu       sync.Mutex
	channels map[bus.Channel]*broadcast[arrival]
	bridged  []FrameSink
	closed   bool
}

// NewFrameHub is a hub with no listener.
func NewFrameHub() *FrameHub {
	return &FrameHub{channels: map[bus.Channel]*broadcast[arrival]{}}
}

// Frames is the frames delivered on any of channels from now on, in the order
// they were delivered, the refusal of a frame refused in its place as its
// error: one listener, taken when Frames is called, and let go when the loop
// over what it returns stops, ctx is done or the hub closes. Of a closed hub,
// a sequence that has ended.
func (h *FrameHub) Frames(ctx context.Context, channels ...bus.Channel) iter.Seq2[Frame, error] {
	q := newQueue[arrival]()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		q.close()
		return toldFrames(q.all(nil, func() {}))
	}
	joined := make([]*broadcast[arrival], 0, len(channels))
	for _, channel := range channels {
		b, ok := h.channels[channel]
		if !ok {
			b = newBroadcast[arrival]()
			h.channels[channel] = b
		}
		b.join(q)
		joined = append(joined, b)
	}
	return toldFrames(q.all(ctx.Done(), func() {
		for _, b := range joined {
			b.leave(q)
		}
	}))
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
	bridged, listening := h.listeners(frame.Channel)
	everyone := frame
	everyone.Scope = api.ResourceId{}
	for _, sink := range bridged {
		sink.Deliver(everyone)
	}
	if listening != nil {
		listening.give(arrival{frame: frame})
	}
}

// DeliverRefusal hands the refusal of a frame, in its place, to every bus
// bridged into, and to its channel's listeners.
func (h *FrameHub) DeliverRefusal(refusal *FrameRefusal) {
	bridged, listening := h.listeners(refusal.Channel)
	everyone := *refusal
	everyone.Scope = api.ResourceId{}
	for _, sink := range bridged {
		sink.DeliverRefusal(&everyone)
	}
	if listening != nil {
		listening.give(arrival{refusal: refusal})
	}
}

// listeners is the buses bridged into, and channel's listeners: nil when
// nobody has listened to it.
func (h *FrameHub) listeners(channel bus.Channel) ([]FrameSink, *broadcast[arrival]) {
	h.mu.Lock()
	defer h.mu.Unlock()
	return slices.Clone(h.bridged), h.channels[channel]
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

// failureStream is what a session says went wrong: T is what each is. Its
// first listener's queue is made with it and held until a listener takes it,
// because the stream opens before whatever reads it is handed the session:
// the first who asks to hear it is given the latest keptForFirst of what was
// said before. Reporting never waits for a reader.
type failureStream[T any] struct {
	b     *broadcast[T]
	mu    sync.Mutex
	first *queue[T]
	// keptForFirst is how many the first listener's queue holds while it is
	// held: the latest, the oldest dropped beyond them.
	keptForFirst int
}

func newFailureStream[T any](keptForFirst int) *failureStream[T] {
	b := newBroadcast[T]()
	return &failureStream[T]{b: b, first: b.listen(), keptForFirst: keptForFirst}
}

// failures is the failures reported from now on; its first listener is given
// first the latest keptForFirst reported since the stream was made.
func (f *failureStream[T]) failures() iter.Seq[T] {
	f.mu.Lock()
	q := f.first
	f.first = nil
	f.mu.Unlock()
	if q == nil {
		q = f.b.listen()
	}
	return q.all(nil, func() { f.b.leave(q) })
}

// report hands err to every listener, and returns it for its caller. While
// the first listener's queue is held, the oldest it holds beyond keptForFirst
// is dropped, under the lock it is handed over under, so its listener is
// given no more.
func (f *failureStream[T]) report(err T) T {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.b.give(err)
	if f.first != nil {
		f.first.keepLatest(f.keptForFirst)
	}
	return err
}

func (f *failureStream[T]) close() { f.b.close() }

// failureTelling is the failures a transport meets, each told to every
// listener within its report, before the call that met it returns, and all
// under one lock, so each listener is told them in the order they were met.
// Of what is reported before anyone listens, the latest keptForFirst are kept
// for the first listener, and told to it as it starts listening, because the
// transport opens before whatever listens to it is returned to its caller
// (protocol/contract/TRANSPORT-CONTRACT.md § Failures).
type failureTelling struct {
	mu        sync.Mutex
	listeners []*failureListener
	// heard holds once anyone has listened: nothing is kept after that.
	heard bool
	// kept is the latest keptForFirst reported before anyone listened.
	kept         []*TransportError
	keptForFirst int
	closed       bool
}

// failureListener is one listener of a transport's failures.
type failureListener struct{ told func(*TransportError) }

// listen tells told each failure reported from now on; the first listener is
// told first the latest keptForFirst reported since the transport was made.
// stop ends the telling: once it returns, a telling under way has ended and
// nothing more is told. Stopping twice is stopping once.
func (f *failureTelling) listen(told func(*TransportError)) (stop func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.heard {
		f.heard = true
		for _, failure := range f.kept {
			told(failure)
		}
		f.kept = nil
	}
	l := &failureListener{told: told}
	if !f.closed {
		f.listeners = append(f.listeners, l)
	}
	return func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.listeners = slices.DeleteFunc(f.listeners, func(each *failureListener) bool { return each == l })
	}
}

// report tells err to every listener, or keeps it for the first, the oldest
// kept dropped beyond keptForFirst, and returns it for its caller. Once the
// transport has closed, it is told nowhere.
func (f *failureTelling) report(err *TransportError) *TransportError {
	f.mu.Lock()
	defer f.mu.Unlock()
	switch {
	case f.closed:
	case !f.heard:
		f.kept = latest(append(f.kept, err), f.keptForFirst)
	default:
		for _, l := range f.listeners {
			l.told(err)
		}
	}
	return err
}

// close ends every listener's telling: nothing more is told, or kept.
func (f *failureTelling) close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.closed = true
	f.listeners = nil
}
