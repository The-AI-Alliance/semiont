package semiont

// A client's own bus: frames published and read inside one process.

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// EventBus is a client's own bus. A client makes one and hands it to its
// transport (Transport.BridgeInto), which delivers into it every frame it
// receives. What the client's own parts say to each other goes through it
// too, and never reaches the wire.
//
// A frame is published to everyone or into one resource's scope, and a reader
// sees one or the other: a reader of a channel does not see a frame published
// into a scope, and a scope's reader sees only its own. A reader of one
// channel is given its frames in the order they were published; two readers
// give no order between them, so one that needs what was said on several
// channels in the order it was said reads them as one (FramesAmong).
type EventBus struct {
	mu sync.Mutex
	// views is the readers of each channel: of what is published to
	// everyone, and of each scope.
	views map[eventView]*broadcast[Frame]
	// among is the readers of several channels at once, each with the
	// channels it reads.
	among  map[*queue[Frame]][]bus.Channel
	closed bool
}

// eventView is a channel, read for everyone or for one scope.
type eventView struct {
	channel bus.Channel
	scope   api.ResourceId
}

var _ FrameSink = (*EventBus)(nil)

// NewEventBus is a bus with no reader.
func NewEventBus() *EventBus {
	return &EventBus{views: map[eventView]*broadcast[Frame]{}, among: map[*queue[Frame]][]bus.Channel{}}
}

// Deliver publishes frame as it is: to everyone, or into the scope its
// envelope names. A closed bus has no reader to give it to.
func (b *EventBus) Deliver(frame Frame) {
	b.mu.Lock()
	view := b.views[eventView{frame.Channel, frame.Scope}]
	var among []*queue[Frame]
	if frame.Scope.IsZero() {
		for q, channels := range b.among {
			for _, channel := range channels {
				if channel == frame.Channel {
					among = append(among, q)
					break
				}
			}
		}
	}
	b.mu.Unlock()
	for _, q := range among {
		q.push(frame)
	}
	if view != nil {
		view.give(frame)
	}
}

// FramesOn is the frames published on channel from now on: to everyone when
// scope is the zero ResourceId, and into scope otherwise. One reader, taken
// when FramesOn is called and let go when the loop over what it returns stops
// or ctx is done; of a closed bus, a sequence that has ended.
func (b *EventBus) FramesOn(ctx context.Context, channel bus.Channel, scope api.ResourceId) iter.Seq[Frame] {
	b.mu.Lock()
	defer b.mu.Unlock()
	q := newQueue[Frame]()
	if b.closed {
		q.close()
		return q.all(nil, func() {})
	}
	key := eventView{channel, scope}
	view, ok := b.views[key]
	if !ok {
		view = newBroadcast[Frame]()
		b.views[key] = view
	}
	view.join(q)
	return q.all(ctx.Done(), func() { view.leave(q) })
}

// FramesAmong is the frames published to everyone on any of channels from
// now on, in the order they were published. One reader, taken when
// FramesAmong is called and let go when the loop over what it returns stops
// or ctx is done; of a closed bus, a sequence that has ended.
func (b *EventBus) FramesAmong(ctx context.Context, channels ...bus.Channel) iter.Seq[Frame] {
	q, leave := b.listenAmong(channels...)
	return q.all(ctx.Done(), leave)
}

// listenAmong is a reader of what is published to everyone on any of
// channels from now on, and what lets it go.
func (b *EventBus) listenAmong(channels ...bus.Channel) (q *queue[Frame], leave func()) {
	b.mu.Lock()
	defer b.mu.Unlock()
	q = newQueue[Frame]()
	if b.closed {
		q.close()
		return q, func() {}
	}
	b.among[q] = channels
	return q, func() {
		b.mu.Lock()
		delete(b.among, q)
		b.mu.Unlock()
		q.close()
	}
}

// Close ends every reader's frames once they are read, and every later
// reader's at once. Closing twice is closing once.
func (b *EventBus) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for _, view := range b.views {
		view.close()
	}
	for q := range b.among {
		q.close()
	}
	clear(b.views)
	clear(b.among)
}

// Publish publishes one frame of c on b: to everyone, or into the scope
// envelope names.
func Publish[P any](b *EventBus, c bus.Global[P], payload P, envelope Envelope) error {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return transportErrorWithoutResponse(fmt.Sprintf("a payload on %s that does not encode: %v", c.Channel(), err), TransportErrorCodeError)
	}
	b.Deliver(Frame{Channel: c.Channel(), Envelope: envelope, Payload: encoded})
	return nil
}

// Published is the frames published to everyone on c from now on, until ctx
// is done, each with its payload decoded. One whose payload is not c's is
// given as its error, and the frames after it follow.
func Published[P any](ctx context.Context, b *EventBus, c bus.Global[P]) iter.Seq2[Delivered[P], error] {
	return typed[P](b.FramesOn(ctx, c.Channel(), api.ResourceId{}))
}

// Decoded is frame read as a frame of c, its payload decoded: how a reader
// of several channels at once (FramesAmong) reads each frame, by its channel.
// A frame of another channel, or a payload that is not c's, is a
// *TransportError saying so.
func Decoded[P any](c bus.Global[P], frame Frame) (Delivered[P], error) {
	if frame.Channel != c.Channel() {
		return Delivered[P]{}, transportErrorWithoutResponse(fmt.Sprintf("a frame on %s read as one on %s", frame.Channel, c.Channel()), TransportErrorCodeError)
	}
	return delivered[P](frame)
}
