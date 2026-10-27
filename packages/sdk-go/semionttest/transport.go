package semionttest

// A scriptable semiont.Transport with no wire, for tests.
//
// Two things are scripted, and they are different things. The wire, by a
// schedule of faults applied one to each request in turn: deliver its reply,
// drop it, delay it, deliver it twice, or refuse the emit. And the gateway,
// by the responses queued for each operation. So "the first reply is lost and
// the retry sees the next page" can be said: a dropped reply still spends its
// queued response, because the gateway answered and the wire ate it.
//
// A request can be scripted to be answered with a failure (RefuseWhen): the
// answer a peer gives when it will not do what was asked. That is not the
// wire failing, and the schedule applies to it as to any reply.
//
// A request nobody scripted a response for is refused, naming the operation.
// A double that answered it with an empty success would hand its caller a
// reply whose every field is absent, which fails far from its cause.
//
// What is emitted through it is delivered through it, to whoever listens, as
// a gateway gives a frame to its subscribers. All of its variation comes in
// through the schedule, so a test that fixes the schedule fixes the run.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"iter"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// FaultAction is what the wire does to one request: Deliver, DropReply,
// Delay, DuplicateReply or RejectEmit. Read it with a type switch.
type FaultAction interface {
	faultAction()
}

// Deliver is the request's reply delivered.
type Deliver struct{}

// DropReply is the request's reply lost.
type DropReply struct{}

// Delay is the request's reply delivered For after the request.
type Delay struct {
	For time.Duration
}

// DuplicateReply is the request's reply delivered twice.
type DuplicateReply struct{}

// RejectEmit is the emit itself refused: the request never reaches the
// gateway.
type RejectEmit struct{}

func (Deliver) faultAction()        {}
func (DropReply) faultAction()      {}
func (Delay) faultAction()          {}
func (DuplicateReply) faultAction() {}
func (RejectEmit) faultAction()     {}

// MakeResponse is what the gateway answers a request with, given its
// operation (the request's channel) and its payload as it was sent: the
// reply's response, or nil for a reply that carries none. An error refuses
// the emit, as RefuseUnscriptedOperation does.
type MakeResponse func(operation bus.Channel, payload json.RawMessage) (json.RawMessage, error)

// Refuse is the failure the gateway answers a request with, when it answers
// it with one: the payload of the operation's failure channel, such as
// {"code":"not-found","message":"…"}; nil when it does not refuse it.
type Refuse func(operation bus.Channel, payload json.RawMessage) json.RawMessage

// RequestLogEntry is one request the transport was sent: the request as it
// was sent (its channel, its envelope and its payload), what the schedule did
// to it, and its identity across retries.
type RequestLogEntry struct {
	semiont.Frame
	// Action is what the schedule did to it.
	Action FaultAction
	// RetryKey is the request's identity across retries: two entries with
	// the same key are one logical request, sent again (RetryKeyOf).
	RetryKey string
}

// stamped is what a gateway stamps on a payload: no part of what was asked.
var stamped = []string{bus.TraceField, "_userId"}

// RetryKeyOf is a request's identity across retries: its channel and its
// payload, less what the gateway stamps on it, its members in name order.
func RetryKeyOf(channel bus.Channel, payload json.RawMessage) string {
	var members map[string]json.RawMessage
	if err := json.Unmarshal(payload, &members); err != nil {
		panic(fmt.Sprintf("semionttest: a request's payload is not an object: %s", payload))
	}
	names := make([]string, 0, len(members))
	for name := range members {
		if !slices.Contains(stamped, name) {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	var b bytes.Buffer
	b.WriteByte('[')
	for i, name := range names {
		if i > 0 {
			b.WriteByte(',')
		}
		quoted, _ := json.Marshal(name)
		b.WriteByte('[')
		b.Write(quoted)
		b.WriteByte(',')
		if err := json.Compact(&b, members[name]); err != nil {
			panic(fmt.Sprintf("semionttest: %s of a request's payload is not JSON: %v", name, err))
		}
		b.WriteByte(']')
	}
	b.WriteByte(']')
	return string(channel) + " " + b.String()
}

// RefuseUnscriptedOperation is what answers a request nothing was scripted
// for: a refusal that names the operation, never a response made up.
func RefuseUnscriptedOperation(operation bus.Channel, _ json.RawMessage) (json.RawMessage, error) {
	return nil, &semiont.TransportError{
		Code: semiont.TransportErrorCodeError,
		Message: fmt.Sprintf(`No response scripted for bus operation %q. `+
			`Script one with QueueReply(%q, …) or build the transport with a MakeResponse that answers it.`, operation, operation),
	}
}

// FaultyConfig is how a FaultyTransport answers.
type FaultyConfig struct {
	// Schedule is what the wire does to each request: the i-th meets
	// Schedule[i % len(Schedule)]. With none, every reply is delivered.
	Schedule []FaultAction
	// MakeResponse answers every request no queued response does. With none,
	// such a request is refused by name (RefuseUnscriptedOperation).
	MakeResponse MakeResponse
	// Channels are the channels its stream delivers with no scope held. With
	// none named, every channel.
	Channels []bus.Channel
}

// FaultyTransport is a semiont.Transport with no wire (see the file's
// documentation). The i-th request meets its schedule's action; a frame it
// is sent comes back to it, as a gateway gives a frame to every client whose
// stream names its channel, only on a channel its stream names: a client's
// stream carries the replies and the broadcasts, and not the requests. Its
// connection is open from the start. An emit reports no count of its
// subscribers until a test says one (Counted).
type FaultyTransport struct {
	config FaultyConfig

	mu      sync.Mutex
	refuse  Refuse
	replies map[bus.Channel][]json.RawMessage
	log     []RequestLogEntry
	emitted []semiont.Frame
	// held is how many holds each resource's scope has.
	held        map[api.ResourceId]int
	subscribers int
	counted     bool
	closed      bool

	hub      *semiont.FrameHub
	router   *semiont.ReplyRouter
	state    *semiont.Variable[semiont.ConnectionState]
	failures *stream[*semiont.TransportError]
}

var _ semiont.Transport = (*FaultyTransport)(nil)

// NewFaultyTransport is a FaultyTransport that answers as config says.
func NewFaultyTransport(config FaultyConfig) *FaultyTransport {
	return &FaultyTransport{
		config:   config,
		replies:  map[bus.Channel][]json.RawMessage{},
		held:     map[api.ResourceId]int{},
		hub:      semiont.NewFrameHub(),
		router:   semiont.NewReplyRouter(),
		state:    semiont.NewVariable(semiont.ConnectionStateOpen),
		failures: newStream[*semiont.TransportError](),
	}
}

// ── What a test says ────────────────────────────────────────────────────

// QueueReply queues what the gateway answers the next requests of operation
// with, one each, before MakeResponse is asked. Each is a response, or nil
// for a reply that carries none. A reply that names what it answers for
// beside its response (the resource a context was gathered for, the
// reference a search was for) names what its request did, as a gateway's
// does: a test queues the response alone.
func (f *FaultyTransport) QueueReply(operation bus.Channel, responses ...json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.replies[operation] = append(f.replies[operation], responses...)
}

// RefuseWhen has the gateway answer with a failure every request refuse
// gives one for. It is asked before anything queued or scripted to answer.
func (f *FaultyTransport) RefuseWhen(refuse Refuse) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refuse = refuse
}

// Fail reports a failure on the failure stream, as a transport does of a
// request the gateway refused.
func (f *FaultyTransport) Fail(err *semiont.TransportError) { f.failures.give(err) }

// SetState changes the connection's state, as a wire would. A closed
// transport's is closed.
func (f *FaultyTransport) SetState(state semiont.ConnectionState) { f.state.Set(state) }

// Counted makes every emit from here on report that the gateway counted n
// subscribers. Zero is a room nobody is in.
func (f *FaultyTransport) Counted(n int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.subscribers, f.counted = n, true
}

// Deliver delivers frame as if the bus had carried it: to the request
// awaiting it, and to whoever listens on its channel. A closed transport has
// nobody to deliver to.
func (f *FaultyTransport) Deliver(frame semiont.Frame) {
	f.router.Route(frame)
	f.hub.Deliver(frame)
}

// ── What a test reads ───────────────────────────────────────────────────

// RequestLog is every request sent, in order.
func (f *FaultyTransport) RequestLog() []RequestLogEntry {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.log)
}

// Emitted is every frame emitted through it, in order: the requests, and
// what was only sent.
func (f *FaultyTransport) Emitted() []semiont.Frame {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.emitted)
}

// Holds is how many holds there are on a resource's scope.
func (f *FaultyTransport) Holds(resource api.ResourceId) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.held[resource]
}

// Scopes is the resources whose scope is held, in name order.
func (f *FaultyTransport) Scopes() []api.ResourceId {
	f.mu.Lock()
	defer f.mu.Unlock()
	scopes := make([]api.ResourceId, 0, len(f.held))
	for resource := range f.held {
		scopes = append(scopes, resource)
	}
	slices.SortFunc(scopes, func(a, b api.ResourceId) int { return strings.Compare(a.String(), b.String()) })
	return scopes
}

// PendingReplies is the correlation ids of the replies still awaited, in
// name order.
func (f *FaultyTransport) PendingReplies() []string { return f.router.IDs() }

// ── The transport ───────────────────────────────────────────────────────

func (f *FaultyTransport) BaseURL() string { return "faulty://simulator" }

// Emit records the frame, and answers a request (an emit on an operation's
// request channel) as the gateway and the schedule say: the gateway answers
// once per request that reaches it, whatever the wire then does to the
// answer. A reply the schedule delivers arrives once the request has been
// given back to the stream, before Emit returns; the client awaits it from
// before it emits. A delayed one arrives later, by the clock. A frame emitted
// on a closed transport goes nowhere.
func (f *FaultyTransport) Emit(_ context.Context, channel bus.Channel, payload map[string]any, envelope semiont.Envelope) (int, bool, error) {
	// As it was sent: its caller changing its own payload afterwards rewrites nothing here.
	sent, err := json.Marshal(payload)
	if err != nil {
		return 0, false, err
	}
	request := semiont.Frame{Channel: channel, Envelope: envelope, Payload: sent}
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return 0, false, nil
	}
	f.emitted = append(f.emitted, request)
	subscribers, counted := f.subscribers, f.counted
	operation, isOperation := bus.Operations[channel]
	if !isOperation {
		f.mu.Unlock()
		f.echo(request)
		return subscribers, counted, nil
	}
	action := FaultAction(Deliver{})
	if n := len(f.config.Schedule); n > 0 {
		action = f.config.Schedule[len(f.log)%n]
	}
	f.log = append(f.log, RequestLogEntry{Frame: request, Action: action, RetryKey: RetryKeyOf(channel, sent)})
	if _, rejected := action.(RejectEmit); rejected {
		f.mu.Unlock()
		return 0, false, &semiont.TransportError{Code: semiont.TransportErrorCodeError, Message: fmt.Sprintf("FaultyTransport: emit rejected by schedule on %s", channel)}
	}
	refuse := f.refuse
	f.mu.Unlock()

	reply, err := f.answer(channel, operation, request, refuse)
	if err != nil {
		return 0, false, err
	}
	f.echo(request)
	switch action := action.(type) {
	case Deliver:
		f.arrive(reply, 1)
	case DuplicateReply:
		f.arrive(reply, 2)
	case Delay:
		time.AfterFunc(action.For, func() { f.arrive(reply, 1) })
	case DropReply:
	}
	return subscribers, counted, nil
}

// answer is the gateway's answer to request: its failure, when refuse gives
// one; else its result, of the response queued for its operation or the one
// MakeResponse makes.
func (f *FaultyTransport) answer(channel bus.Channel, operation bus.Replies, request semiont.Frame, refuse Refuse) (semiont.Frame, error) {
	answering := semiont.Envelope{CorrelationID: request.CorrelationID}
	if refuse != nil {
		if refused := refuse(channel, request.Payload); refused != nil {
			return semiont.Frame{Channel: operation.Failure, Envelope: answering, Payload: refused}, nil
		}
	}
	response, queued := f.next(channel)
	if !queued {
		makeResponse := f.config.MakeResponse
		if makeResponse == nil {
			makeResponse = RefuseUnscriptedOperation
		}
		made, err := makeResponse(channel, request.Payload)
		if err != nil {
			return semiont.Frame{}, err
		}
		response = made
	}
	var asked map[string]json.RawMessage
	if err := json.Unmarshal(request.Payload, &asked); err != nil {
		return semiont.Frame{}, err
	}
	answered := map[string]json.RawMessage{}
	// A reply that names what it answers for names what its request did, as a gateway's does.
	for _, named := range operation.ReplyNames {
		value, stated := asked[named]
		if !stated {
			return semiont.Frame{}, &semiont.TransportError{Code: semiont.TransportErrorCodeError, Message: fmt.Sprintf("FaultyTransport: the reply to %s names %q, which this request does not state", channel, named)}
		}
		answered[named] = value
	}
	if response != nil {
		answered["response"] = response
	}
	payload, err := json.Marshal(answered)
	if err != nil {
		return semiont.Frame{}, err
	}
	return semiont.Frame{Channel: operation.Result, Envelope: answering, Payload: payload}, nil
}

// next takes the response queued next for operation; false when none is.
func (f *FaultyTransport) next(operation bus.Channel) (json.RawMessage, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	queued := f.replies[operation]
	if len(queued) == 0 {
		return nil, false
	}
	f.replies[operation] = queued[1:]
	return queued[0], true
}

// echo gives a frame this transport sent back to it, when its stream names
// the frame's channel.
func (f *FaultyTransport) echo(sent semiont.Frame) {
	if f.IsSubscribed(sent.Channel) {
		f.Deliver(sent)
	}
}

// arrive delivers reply copies times; a reply on its way when the transport
// closes is dropped.
func (f *FaultyTransport) arrive(reply semiont.Frame, copies int) {
	f.mu.Lock()
	closed := f.closed
	f.mu.Unlock()
	if closed {
		return
	}
	for range copies {
		f.Deliver(reply)
	}
}

func (f *FaultyTransport) Frames(ctx context.Context, channels ...bus.Channel) (iter.Seq[semiont.Frame], error) {
	if len(channels) == 0 {
		return nil, fmt.Errorf("Frames names no channel to listen to")
	}
	for _, channel := range channels {
		if !f.IsSubscribed(channel) && !slices.Contains(bus.ResourceScopedChannels, channel) {
			return nil, &semiont.BusRequestError{
				Code:    semiont.BusRequestErrorCodeUnsubscribed,
				Message: fmt.Sprintf("this transport's stream does not carry %s: nothing on it can be delivered", channel),
			}
		}
	}
	return f.hub.Frames(ctx, channels...), nil
}

func (f *FaultyTransport) IsSubscribed(channel bus.Channel) bool {
	return f.config.Channels == nil || slices.Contains(f.config.Channels, channel)
}

// SubscribeToResource takes one hold on resource's scope, which Holds counts;
// release lets it go, once. Nothing here is delivered by scope, so a hold
// changes only the count of them.
func (f *FaultyTransport) SubscribeToResource(resource api.ResourceId) (release func()) {
	f.mu.Lock()
	f.held[resource]++
	f.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			f.mu.Lock()
			defer f.mu.Unlock()
			if f.held[resource]--; f.held[resource] == 0 {
				delete(f.held, resource)
			}
		})
	}
}

func (f *FaultyTransport) TrackReply(correlationID string, channels ...bus.Channel) *semiont.PendingReply {
	return f.router.Track(correlationID, channels)
}

func (f *FaultyTransport) State() semiont.Watched[semiont.ConnectionState] { return f.state.Reading() }

func (f *FaultyTransport) BridgeInto(sink semiont.FrameSink) { f.hub.Bridge(sink) }

// Failures is the failures Fail reports from now on, until the transport
// closes.
func (f *FaultyTransport) Failures() iter.Seq[*semiont.TransportError] { return f.failures.listen() }

func (f *FaultyTransport) Close() {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return
	}
	f.closed = true
	f.mu.Unlock()
	f.state.Set(semiont.ConnectionStateClosed)
	f.state.End()
	f.hub.Close()
	f.router.Close()
	f.failures.close()
}
