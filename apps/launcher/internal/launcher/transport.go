package launcher

// transport.go — where a verb gets its bus: one transport per command,
// holding one stream to the stack's gateway, carrying the session's token and
// renewed by the session when the gateway refuses it.
//
// The transport is made in one place, behind a swappable function, so a verb
// can be observed in process: a test hands it a fake. This is the seam, not a
// factory: production has exactly one implementation, which is why it is a
// plain package-level func rather than a registry.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// newTransport makes the transport a verb talks through. Tests replace it via
// UseTransport.
var newTransport = func(config semiont.HTTPTransportConfig) semiont.Transport {
	return semiont.NewHTTPTransport(config)
}

// UseTransport swaps the constructor and returns a restore func. Test-only by
// intent; it lives in the non-test file because the variable it closes over
// does, and Go has no narrower visibility that keeps them together.
func UseTransport(f func(config semiont.HTTPTransportConfig) semiont.Transport) (restore func()) {
	prev := newTransport
	newTransport = f
	return func() { newTransport = prev }
}

// replyChannels is every operation's result and failure channel: what a
// command's stream carries so that any request it makes can be answered. No
// broadcast is among them: a stream that carried the signals a verb emits
// would be counted among their audience, and `beckon` would report itself as
// the one subscriber it reached.
func replyChannels() []bus.Channel {
	channels := make([]bus.Channel, 0, 2*len(bus.Operations))
	for _, operation := range bus.Operations {
		channels = append(channels, operation.Result, operation.Failure)
	}
	return channels
}

// VerbBus is one command's bus: a transport to its stack's gateway, carrying
// the session's token. Close it when the command is done.
type VerbBus struct {
	sess      *Session
	transport semiont.Transport
	wire      *semiont.Wire
}

// bus opens the stack's bus. Its stream carries every operation's reply
// channels, and channels besides: a verb that follows broadcasts names them.
// A token the store already knows is expired is renewed before the stream
// opens. When that renewal fails the stored token is still tried — clocks
// skew, and the gateway is the judge — and the failure answers the gateway's
// refusal; a token the issuer has just issued and the gateway refuses ends
// the session before anything is sent.
func (s *Session) bus(channels []bus.Channel) *VerbBus {
	s.renewal.Lock()
	if s.expired() {
		if rejected := s.renew(s.ended); rejected != nil && rejected.refresh == nil {
			s.end(rejected)
		}
	}
	s.renewal.Unlock()
	transport := newTransport(semiont.HTTPTransportConfig{
		BaseURL:   s.base,
		Token:     s.token,
		Refresher: s,
		Channels:  append(replyChannels(), channels...),
		HTTP:      &http.Client{Transport: launcherTransport},
		Timing:    semiont.DefaultTiming(),
	})
	return &VerbBus{sess: s, transport: transport, wire: semiont.NewWire(transport)}
}

// Request asks the operation whose request channel is op, with request — the
// generated type of its payload — and waits up to within for the reply: its
// response, or nil when it carries none. A session the gateway refused for
// good ends the wait, and is the error: a *SessionRejected.
func (b *VerbBus) Request(op bus.Channel, request any, within time.Duration) (json.RawMessage, error) {
	payload, err := payloadOf(request)
	if err != nil {
		return nil, err
	}
	response, err := b.wire.RequestOf(b.sess.ended, op, payload, within)
	if err != nil {
		return nil, b.sess.refusal(err)
	}
	return response, nil
}

// Emit sends event — the generated type of channel's payload — as one frame
// that awaits no reply. It reports how many subscribers the gateway counted,
// and counted=false when it gave no count, which is not a zero.
func (b *VerbBus) Emit(channel bus.Channel, event any) (subscribers int, counted bool, err error) {
	payload, err := payloadOf(event)
	if err != nil {
		return 0, false, err
	}
	subscribers, counted, err = b.wire.EmitOn(b.sess.ended, channel, payload, semiont.Envelope{})
	if err != nil {
		return 0, false, b.sess.refusal(err)
	}
	return subscribers, counted, nil
}

// Transport is the bus's transport, for what a verb takes from it directly:
// the frames of a channel, a resource's scope, the stream's state.
func (b *VerbBus) Transport() semiont.Transport { return b.transport }

// Context ends when the gateway has refused the session's token for good,
// with the session's *SessionRejected as its cause. A verb that waits on
// frames waits under it.
func (b *VerbBus) Context() context.Context { return b.sess.ended }

// Close stops the transport and every sequence of frames taken from it.
func (b *VerbBus) Close() { b.transport.Close() }

// payloadOf is a request or an event, a generated type, as the JSON object a
// frame carries. Numbers are kept as the text they were written as, so none
// is rounded on its way to the wire.
func payloadOf(v any) (map[string]any, error) {
	encoded, err := json.Marshal(v)
	if err != nil {
		return nil, fmt.Errorf("encoding %T: %w", v, err)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var payload map[string]any
	if err := decoder.Decode(&payload); err != nil {
		return nil, fmt.Errorf("%T is not a JSON object: %w", v, err)
	}
	if payload == nil {
		return nil, fmt.Errorf("%T encodes as null, not a JSON object", v)
	}
	return payload, nil
}

// refusal is a bus error as a verb reports it. A refused credential, and a
// wait the session's end cut short, are the session's rejection; anything
// else is as it came.
func (s *Session) refusal(err error) error {
	var refused *semiont.TransportError
	if errors.As(err, &refused) && refused.Code == semiont.TransportErrorCodeUnauthorized {
		// The transport asked the session for a token and sent the request
		// again with it, so this is the second refusal: unless the session has
		// already ended for its own reason, the gateway refused a token the
		// session had just renewed.
		s.renewal.Lock()
		s.end(&SessionRejected{cause: err})
		s.renewal.Unlock()
		return context.Cause(s.ended)
	}
	if errors.Is(err, context.Canceled) && s.ended.Err() != nil {
		return context.Cause(s.ended)
	}
	return err
}
