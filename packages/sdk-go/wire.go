package semiont

// A client's bus over its transport: emits, frames and requests, by the
// channel's name. A request is an emit that expects a correlated reply
// (docs/protocol/TRANSPORT-CONTRACT.md § Requests).

import (
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
	operation, ok := bus.Operations[request]
	if !ok {
		return nil, fmt.Errorf("%s is the request of no operation of the registry", request)
	}
	for _, channel := range []bus.Channel{operation.Result, operation.Failure} {
		if !w.transport.IsSubscribed(channel) {
			return nil, &BusRequestError{
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
			return nil, &BusRequestError{Code: BusRequestErrorCodeClosed, Message: fmt.Sprintf("Bus closed before emit on %s", request)}
		}
	}
	if !open {
		return nil, ended()
	}

	// Tracked before the emit, so a stream opened while the emit is in flight
	// already names the reply.
	correlationID := uuid.NewString()
	pending := w.transport.TrackReply(correlationID, operation.Result, operation.Failure)
	defer pending.Release()
	if _, _, err := w.transport.Emit(waiting, request, payload, Envelope{CorrelationID: correlationID}); err != nil {
		if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
			return nil, ended()
		}
		return nil, err
	}

	var reply Frame
	select {
	case frame, delivered := <-pending.Reply():
		if !delivered {
			return nil, &BusRequestError{Code: BusRequestErrorCodeClosed, Message: fmt.Sprintf("Bus closed before a reply on %s", operation.Result)}
		}
		reply = frame
	case <-waiting.Done():
		return nil, ended()
	}
	if reply.Channel == operation.Result {
		var result struct {
			Response json.RawMessage `json:"response"`
		}
		if err := json.Unmarshal(reply.Payload, &result); err != nil {
			return nil, &BusRequestError{Code: BusRequestErrorCodeRejected, Message: fmt.Sprintf("the reply on %s is not its result: %v", reply.Channel, err), Failure: reply.Payload}
		}
		return result.Response, nil
	}
	var failure struct {
		Code    *api.CommandErrorCode `json:"code"`
		Message *string               `json:"message"`
	}
	message := "Bus request rejected"
	if json.Unmarshal(reply.Payload, &failure) == nil && failure.Message != nil {
		message = *failure.Message
	}
	return nil, &BusRequestError{Code: BusRequestErrorCodeOfWire(failure.Code), Message: message, Failure: reply.Payload}
}
