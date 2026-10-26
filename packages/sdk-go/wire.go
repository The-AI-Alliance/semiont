package semiont

// A client's bus over its transport: emits, frames and requests, by the
// channel's name. A request is an emit that expects a correlated reply
// (docs/protocol/TRANSPORT-CONTRACT.md § Requests).

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"time"

	"github.com/google/uuid"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// Wire is the bus over a transport.
type Wire struct {
	transport Transport
}

// NewWire is the bus over transport.
func NewWire(transport Transport) *Wire { return &Wire{transport: transport} }

// EmitOn sends one frame on channel.
func (w *Wire) EmitOn(ctx context.Context, channel bus.Channel, payload map[string]any, envelope Envelope) (subscribers int, counted bool, err error) {
	return w.transport.Emit(ctx, channel, payload, envelope)
}

// FramesOn is the frames delivered on any of channels from now on, in the
// order they were delivered.
func (w *Wire) FramesOn(channels ...bus.Channel) (iter.Seq[Frame], error) {
	return w.transport.Frames(channels...)
}

// RequestOf sends payload as the request of the operation whose request
// channel is request, and waits up to within for its reply: the reply's
// response, or nil when it carries none. A context that is done abandons
// the request: what was sent stays sent, the reply stops being tracked, and
// its error is returned. Abandoned while it waits for the stream, it is
// never sent.
func (w *Wire) RequestOf(ctx context.Context, request bus.Channel, payload map[string]any, within time.Duration) (json.RawMessage, error) {
	reply, err := w.result(ctx, request, payload, within, nil)
	if err != nil {
		return nil, err
	}
	var result struct {
		Response json.RawMessage `json:"response"`
	}
	if err := json.Unmarshal(reply.Payload, &result); err != nil {
		return nil, &BusRequestError{Code: BusRequestErrorCodeRejected, Message: fmt.Sprintf("the reply on %s is not its result: %v", reply.Channel, err), Failure: reply.Payload}
	}
	return result.Response, nil
}

// result is a request, as far as the frame that answers it on its result
// channel. A failure answered is a *BusRequestError carrying it. asking, when
// it is not nil, is called as the request is sent.
func (w *Wire) result(ctx context.Context, request bus.Channel, payload map[string]any, within time.Duration, asking func()) (Frame, error) {
	operation, ok := bus.Operations[request]
	if !ok {
		return Frame{}, fmt.Errorf("%s is the request of no operation of the registry", request)
	}
	for _, channel := range []bus.Channel{operation.Result, operation.Failure} {
		if !w.transport.IsSubscribed(channel) {
			return Frame{}, &BusRequestError{
				Code:    BusRequestErrorCodeUnsubscribed,
				Message: fmt.Sprintf("Transport is not subscribed to reply channel %s: a reply to %s can never arrive. Add this operation's reply channels to the transport's channels.", channel, request),
			}
		}
	}
	timedOut := &BusRequestError{
		Code:    BusRequestErrorCodeTimeout,
		Message: fmt.Sprintf("Bus request timed out after %dms on %s", within.Milliseconds(), operation.Result),
	}
	waiting, cancel := context.WithTimeout(ctx, within)
	defer cancel()
	ended := func() error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return timedOut
	}

	// No request before its reply can arrive: wait, inside the request's own
	// deadline, for the stream to be open. Only open delivers; a closed bus
	// fails at once rather than burning the deadline.
	open := false
	for state := range w.transport.StateChanges(waiting) {
		if state == ConnectionStateOpen {
			open = true
			break
		}
		if state == ConnectionStateClosed {
			return Frame{}, &BusRequestError{Code: BusRequestErrorCodeClosed, Message: fmt.Sprintf("Bus closed before emit on %s", request)}
		}
	}
	if !open {
		return Frame{}, ended()
	}

	// Tracked before the emit, so a stream opened while the emit is in flight
	// already names the reply.
	correlationID := uuid.NewString()
	pending := w.transport.TrackReply(correlationID, operation.Result, operation.Failure)
	defer pending.Release()
	if asking != nil {
		asking()
	}
	if _, _, err := w.transport.Emit(waiting, request, payload, Envelope{CorrelationID: correlationID}); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return Frame{}, ended()
		}
		return Frame{}, err
	}

	var reply Frame
	select {
	case frame, delivered := <-pending.Reply():
		if !delivered {
			return Frame{}, &BusRequestError{Code: BusRequestErrorCodeClosed, Message: fmt.Sprintf("Bus closed before a reply on %s", operation.Result)}
		}
		reply = frame
	case <-waiting.Done():
		return Frame{}, ended()
	}
	if reply.Channel == operation.Result {
		return reply, nil
	}
	var failure struct {
		Code    *api.CommandErrorCode `json:"code"`
		Message *string               `json:"message"`
	}
	message := "Bus request rejected"
	if json.Unmarshal(reply.Payload, &failure) == nil && failure.Message != nil {
		message = *failure.Message
	}
	return Frame{}, &BusRequestError{Code: BusRequestErrorCodeOfWire(failure.Code), Message: message, Failure: reply.Payload}
}

// ── By type ─────────────────────────────────────────────────────────────

// Delivered is a frame of one channel, its payload decoded.
type Delivered[P any] struct {
	Payload P
	Envelope
	// UserID is who emitted it, as the gateway stamped it; the zero UserId
	// when no stamp names one.
	UserID api.UserId
	// Trace is the trace the frame was sent under; the zero TraceContext
	// when it was sent under none.
	Trace TraceContext
}

// delivered is frame with its payload decoded as P. A payload that is not
// P's is a *TransportError saying so; what a gateway stamps on a payload is
// the bus's, and P does not read it unless P declares it.
func delivered[P any](frame Frame) (Delivered[P], error) {
	var payload P
	if err := json.Unmarshal(frame.Payload, &payload); err != nil {
		return Delivered[P]{}, transportErrorWithoutResponse(fmt.Sprintf("a payload on %s is not that channel's: %v", frame.Channel, err), TransportErrorCodeError)
	}
	var stamped struct {
		UserID *string `json:"_userId"`
	}
	var userID api.UserId
	if json.Unmarshal(frame.Payload, &stamped) == nil && stamped.UserID != nil {
		if parsed, err := api.ParseUserId(*stamped.UserID); err == nil {
			userID = parsed
		}
	}
	return Delivered[P]{Payload: payload, Envelope: frame.Envelope, UserID: userID, Trace: frame.Trace}, nil
}

// typed is frames, each with its payload decoded as P. One that is not P's
// is given as its error, and the frames after it follow.
func typed[P any](frames iter.Seq[Frame]) iter.Seq2[Delivered[P], error] {
	return func(yield func(Delivered[P], error) bool) {
		for frame := range frames {
			if !yield(delivered[P](frame)) {
				return
			}
		}
	}
}

// payloadOf is payload as the JSON object the untyped wire carries, its
// numbers kept exactly as they were written.
func payloadOf(payload any) (map[string]any, error) {
	encoded, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var object map[string]any
	if err := decoder.Decode(&object); err != nil {
		return nil, fmt.Errorf("a payload of %T is not a JSON object: %w", payload, err)
	}
	return object, nil
}

// Emit sends one frame on c: how many subscribers the gateway reached, or
// counted false when it kept no count.
func Emit[P any](ctx context.Context, w *Wire, c bus.Emittable[P], payload P, envelope Envelope) (subscribers int, counted bool, err error) {
	object, err := payloadOf(payload)
	if err != nil {
		return 0, false, err
	}
	return w.transport.Emit(ctx, c.Channel(), object, envelope)
}

// Frames is the frames delivered on c from now on, each with its payload
// decoded. A channel the transport can never deliver is refused, as
// unsubscribed. A channel a resource's scope carries is read for a resource
// (FramesOf), and does not compile here, where nothing would be delivered to
// it.
func Frames[P any](w *Wire, c bus.Global[P]) (iter.Seq2[Delivered[P], error], error) {
	frames, err := w.transport.Frames(c.Channel())
	if err != nil {
		return nil, err
	}
	return typed[P](frames), nil
}

// FramesOf is the frames delivered on c for resource from now on, each with
// its payload decoded. c reaches only a client that holds the resource's
// scope, so the read holds it while it is read, and is given that resource's
// frames and no other's.
func FramesOf[P, E any](w *Wire, c bus.Scoped[P, E], resource api.ResourceId) (iter.Seq2[Delivered[P], error], error) {
	frames, err := w.transport.Frames(c.Channel())
	if err != nil {
		return nil, err
	}
	return func(yield func(Delivered[P], error) bool) {
		release := w.transport.SubscribeToResource(resource)
		defer release()
		for frame := range frames {
			// A stream carries every scope it holds on the one channel, and another reader may hold another resource's.
			if frame.Scope != resource {
				continue
			}
			if !yield(delivered[P](frame)) {
				return
			}
		}
	}, nil
}

// Request sends payload as the request of op, and waits up to within for its
// result, which it gives decoded. It fails as RequestOf does, and with a
// *TransportError when the result that came is not op's.
func Request[Q, R, F any](ctx context.Context, w *Wire, op bus.Operation[Q, R, F], payload Q, within time.Duration) (R, error) {
	return requestAsking(ctx, w, op, payload, within, nil)
}

// requestAsking is Request, calling asking, when it is not nil, as the
// request is sent.
func requestAsking[Q, R, F any](ctx context.Context, w *Wire, op bus.Operation[Q, R, F], payload Q, within time.Duration, asking func()) (R, error) {
	var none R
	object, err := payloadOf(payload)
	if err != nil {
		return none, err
	}
	reply, err := w.result(ctx, op.Request().Channel(), object, within, asking)
	if err != nil {
		return none, err
	}
	answer, err := delivered[R](reply)
	if err != nil {
		return none, err
	}
	return answer.Payload, nil
}
