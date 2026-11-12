package semiont

// What a transport delivers, and to whom: frames by channel, and the failures
// it met. Each listener of frames has a queue of its own (kept.Queue), and
// delivering to it never waits: a slow listener delays no other listener and
// no reply, and is given every item, in order. Each failure a transport meets
// is told to its listeners within its report.

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"slices"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/kept"
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
	channels map[bus.Channel]*kept.Broadcast[arrival]
	bridged  []FrameSink
	closed   bool
}

// NewFrameHub is a hub with no listener.
func NewFrameHub() *FrameHub {
	return &FrameHub{channels: map[bus.Channel]*kept.Broadcast[arrival]{}}
}

// Frames is the frames delivered on any of channels from now on, in the order
// they were delivered, the refusal of a frame refused in its place as its
// error: one listener, taken when Frames is called, and let go when the loop
// over what it returns stops, ctx is done or the hub closes. Of a closed hub,
// a sequence that has ended.
func (h *FrameHub) Frames(ctx context.Context, channels ...bus.Channel) iter.Seq2[Frame, error] {
	q := kept.NewQueue[arrival]()
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		q.Close()
		return toldFrames(q.All(nil, func() {}))
	}
	joined := make([]*kept.Broadcast[arrival], 0, len(channels))
	for _, channel := range channels {
		b, ok := h.channels[channel]
		if !ok {
			b = kept.NewBroadcast[arrival]()
			h.channels[channel] = b
		}
		b.Join(q)
		joined = append(joined, b)
	}
	return toldFrames(q.All(ctx.Done(), func() {
		for _, b := range joined {
			b.Leave(q)
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
		listening.Give(arrival{frame: frame})
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
		listening.Give(arrival{refusal: refusal})
	}
}

// listeners is the buses bridged into, and channel's listeners: nil when
// nobody has listened to it.
func (h *FrameHub) listeners(channel bus.Channel) ([]FrameSink, *kept.Broadcast[arrival]) {
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
		b.Close()
	}
	h.bridged = nil
}
