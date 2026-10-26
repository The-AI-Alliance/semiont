// Package bustest provides a fake semiont.Transport for tests: the Go
// counterpart of core's FaultyTransport.
//
// Named for the `net/http/httptest` convention: a testing companion beside the
// package it doubles, kept out of that package's own surface.
//
// It records what was sent and answers with what the test scripted, through
// the reply router and the frame hub a transport routes its own frames
// through. Consumers that would otherwise need a live gateway — the
// launcher's verbs — can be exercised in process with no binary, no socket,
// and no ports.
package bustest

import (
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"sync"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Emitted is one recorded emit that awaits no reply: an emit with no
// correlation id.
type Emitted struct {
	Channel bus.Channel
	Payload map[string]any
	Scope   api.ResourceId
}

// Requested is one recorded request: an emit carrying a correlation id. The
// PAYLOAD is recorded, not just the operation: most of what a verb gets wrong
// is what it put in the request — a missing filter, a selector built from the
// wrong flag, an id that never made it onto the wire.
type Requested struct {
	Channel bus.Channel
	Payload map[string]any
	Scope   api.ResourceId
	// CorrelationID is the request's key: what its reply is delivered
	// under.
	CorrelationID string
}

// Fake implements semiont.Transport. The zero value is not ready — use
// NewFake. Its stream is open from the start and carries every channel. An
// emit is uncounted until a test calls Counted: the honest default, where a
// silent 0 would read as "nobody is listening".
type Fake struct {
	mu sync.Mutex

	// What Emit reports, set by Counted.
	subscribers int
	counted     bool
	// EmitErr, when set, is what every emit is refused with.
	EmitErr error

	// Replies scripts the result a request is answered with: request
	// channel → the payload of the operation's result.
	Replies map[bus.Channel]json.RawMessage
	// Rejections scripts the failure a request is answered with instead:
	// request channel → the payload of the operation's failure.
	Rejections map[bus.Channel]json.RawMessage
	// Queued scripts the results the next requests of an operation are
	// answered with, one each, in order, before Replies is asked: request
	// channel → the payloads of the operation's result.
	Queued map[bus.Channel][]json.RawMessage
	// Unanswered names the request channels whose requests are recorded and
	// never answered: a test answers one itself, by Deliver, under its
	// CorrelationID.
	Unanswered map[bus.Channel]bool

	// Emits records every emit that awaits no reply, in order — a fan-out
	// verb that drops its second command is invisible to a last-call-only
	// assertion.
	Emits []Emitted
	// Requests records every request, in order, with its payload.
	Requests []Requested

	// holds is how many holds each resource's scope has.
	holds map[api.ResourceId]int

	hub       *semiont.FrameHub
	router    *semiont.ReplyRouter
	state     *semiont.Variable[semiont.ConnectionState]
	closed    chan struct{}
	closeOnce sync.Once
}

var _ semiont.Transport = (*Fake)(nil)

func NewFake() *Fake {
	return &Fake{
		Replies:    map[bus.Channel]json.RawMessage{},
		Rejections: map[bus.Channel]json.RawMessage{},
		Queued:     map[bus.Channel][]json.RawMessage{},
		Unanswered: map[bus.Channel]bool{},
		holds:      map[api.ResourceId]int{},
		hub:        semiont.NewFrameHub(),
		router:     semiont.NewReplyRouter(),
		state:      semiont.NewVariable(semiont.ConnectionStateOpen),
		closed:     make(chan struct{}),
	}
}

// Counted makes every Emit from here on report that the gateway counted n
// subscribers. Zero is a genuine empty room; tests choose deliberately.
func (f *Fake) Counted(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subscribers, f.counted = n, true
}

func (f *Fake) BaseURL() string { return "http://fake.test" }

// Emit records the frame. A request — an emit carrying a correlation id on
// an operation's request channel — is answered at once, on the stream: with
// its scripted rejection, or the next of its queued results, or its scripted
// reply, or, when the test scripted none, a failure that says so; one on an
// Unanswered channel is not answered. An unscripted operation is a test bug, and
// a request left to wait out its deadline would hide it behind a timeout.
func (f *Fake) Emit(_ context.Context, channel bus.Channel, payload map[string]any, envelope semiont.Envelope) (int, bool, error) {
	f.mu.Lock()
	if envelope.CorrelationID == "" {
		f.Emits = append(f.Emits, Emitted{Channel: channel, Payload: payload, Scope: envelope.Scope})
	} else {
		f.Requests = append(f.Requests, Requested{Channel: channel, Payload: payload, Scope: envelope.Scope, CorrelationID: envelope.CorrelationID})
	}
	if f.EmitErr != nil {
		err := f.EmitErr
		f.mu.Unlock()
		return 0, false, err
	}
	subscribers, counted := f.subscribers, f.counted
	operation, isOperation := bus.Operations[channel]
	if !isOperation || envelope.CorrelationID == "" || f.Unanswered[channel] {
		f.mu.Unlock()
		return subscribers, counted, nil
	}
	answer := semiont.Frame{Envelope: semiont.Envelope{CorrelationID: envelope.CorrelationID}}
	if rejection, scripted := f.Rejections[channel]; scripted {
		answer.Channel, answer.Payload = operation.Failure, rejection
	} else if queued := f.Queued[channel]; len(queued) > 0 {
		answer.Channel, answer.Payload = operation.Result, queued[0]
		f.Queued[channel] = queued[1:]
	} else if reply, scripted := f.Replies[channel]; scripted {
		answer.Channel, answer.Payload = operation.Result, reply
	} else {
		answer.Channel, answer.Payload = operation.Failure, unscripted(channel)
	}
	f.mu.Unlock()
	f.Deliver(answer)
	return subscribers, counted, nil
}

// unscripted is the failure a request no test scripted is answered with.
func unscripted(channel bus.Channel) json.RawMessage {
	failure, err := json.Marshal(api.CommandError{Message: fmt.Sprintf("bustest.Fake has no scripted reply for %q", channel)})
	if err != nil {
		panic(err)
	}
	return failure
}

// Deliver delivers frame as the stream would: to the request awaiting it,
// and to whoever listens on its channel.
func (f *Fake) Deliver(frame semiont.Frame) {
	f.router.Route(frame)
	f.hub.Deliver(frame)
}

func (f *Fake) Frames(channels ...bus.Channel) (iter.Seq[semiont.Frame], error) {
	return f.hub.Frames(channels...), nil
}

// BridgeInto delivers into sink every frame Deliver is given from now on,
// each published to everyone there whichever scope it came on.
func (f *Fake) BridgeInto(sink semiont.FrameSink) { f.hub.Bridge(sink) }

func (f *Fake) IsSubscribed(bus.Channel) bool { return true }

// SubscribeToResource takes one hold on resource's scope, which Holds
// counts; release lets it go, once. Every frame Deliver is given reaches its
// channel's listeners whatever is held.
func (f *Fake) SubscribeToResource(resource api.ResourceId) (release func()) {
	f.mu.Lock()
	f.holds[resource]++
	f.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.holds[resource]--; f.holds[resource] == 0 {
				delete(f.holds, resource)
			}
		})
	}
}

// Holds is how many holds resource's scope has now.
func (f *Fake) Holds(resource api.ResourceId) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.holds[resource]
}

// SetState moves the connection's state, as a stream that drops and opens
// again would.
func (f *Fake) SetState(state semiont.ConnectionState) { f.state.Set(state) }

func (f *Fake) TrackReply(correlationID string, channels ...bus.Channel) *semiont.PendingReply {
	return f.router.Track(correlationID, channels)
}

func (f *Fake) State() semiont.ConnectionState { return f.state.Value() }

func (f *Fake) StateChanges(ctx context.Context) iter.Seq[semiont.ConnectionState] {
	return f.state.Changes(ctx)
}

// Failures reports none, and ends when the fake closes.
func (f *Fake) Failures() iter.Seq[*semiont.TransportError] {
	return func(func(*semiont.TransportError) bool) { <-f.closed }
}

func (f *Fake) Close() {
	f.closeOnce.Do(func() {
		f.state.Set(semiont.ConnectionStateClosed)
		f.router.Close()
		f.hub.Close()
		close(f.closed)
	})
}

// Sent is what has been sent so far, in order: every emit that awaits no
// reply, and every request. Safe to call while sending goes on.
func (f *Fake) Sent() (emits []Emitted, requests []Requested) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Emitted(nil), f.Emits...), append([]Requested(nil), f.Requests...)
}

// Ops is the recorded operations in order — the common assertion, without
// making every caller reach through the payload it does not care about.
func (f *Fake) Ops() []bus.Channel {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]bus.Channel, len(f.Requests))
	for i, r := range f.Requests {
		out[i] = r.Channel
	}
	return out
}

// JSON renders a recorded payload the way it went on the wire, for substring
// assertions about fields a verb built.
func JSON(payload any) string {
	b, err := json.Marshal(payload)
	if err != nil {
		return fmt.Sprintf("<unmarshalable: %v>", err)
	}
	return string(b)
}
