package semiont

// The transport over HTTP (docs/protocol/TRANSPORT-HTTP.md): POST /bus/emit
// for each frame out, and one held POST /bus/subscribe stream for frames in,
// which stream.go keeps.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"iter"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// TokenRefresher renews a token the gateway refused. It is asked once for a
// refused request, and once per outage of the stream.
type TokenRefresher interface {
	// Refresh is a renewed token; ok is false when there is none to give.
	Refresh(ctx context.Context) (token string, ok bool)
}

// HTTPTransportConfig is what an HTTPTransport is made with.
type HTTPTransportConfig struct {
	// BaseURL is the gateway's origin: scheme, host and port.
	BaseURL string
	// Token is the credential each request carries, as it is now; the empty
	// string is none. The stream watches it: a client with none, or with one
	// the gateway refused, opens its stream when it changes.
	Token *Watched[string]
	// Refresher renews a refused token; nil for a client that cannot renew
	// its token.
	Refresher TokenRefresher
	// Channels is the global channels the stream names.
	Channels []bus.Channel
	// HTTP is what the requests are made with.
	HTTP *http.Client
	// Timing is the timing the transport keeps.
	Timing Timing
}

// transportShared is what the transport's handle and its stream both hold.
type transportShared struct {
	baseURL   string
	http      *http.Client
	token     *Watched[string]
	refresher TokenRefresher
	// clientID is this client's address for correlated replies: one per
	// transport, not per connection, so both streams of a handoff present the
	// same one.
	clientID string
	global   []bus.Channel
	timing   Timing
	hub      *FrameHub
	router   *ReplyRouter
	failures *failureStream
}

// HTTPTransport is the Transport over HTTP. Its stream opens in the
// background as soon as there is a token. Close stops it.
type HTTPTransport struct {
	shared   *transportShared
	state    *Watched[ConnectionState]
	commands chan<- command
	stopped  <-chan struct{}

	holdsMu sync.Mutex
	holds   map[api.ResourceId]int

	closeOnce sync.Once
}

var _ Transport = (*HTTPTransport)(nil)

// NewHTTPTransport is a transport to the gateway at config.BaseURL.
func NewHTTPTransport(config HTTPTransportConfig) *HTTPTransport {
	shared := &transportShared{
		baseURL:   strings.TrimRight(config.BaseURL, "/"),
		http:      config.HTTP,
		token:     config.Token,
		refresher: config.Refresher,
		clientID:  uuid.NewString(),
		global:    slices.Clone(config.Channels),
		timing:    config.Timing,
		hub:       NewFrameHub(),
		router:    NewReplyRouter(),
		failures:  newFailureStream(),
	}
	state := NewWatched(ConnectionStateInitial)
	s := newStream(shared, state)
	stopped := make(chan struct{})
	go s.run(stopped)
	return &HTTPTransport{
		shared:   shared,
		state:    state,
		commands: s.commands,
		stopped:  stopped,
		holds:    map[api.ResourceId]int{},
	}
}

// BaseURL is the gateway's origin.
func (t *HTTPTransport) BaseURL() string { return t.shared.baseURL }

// ClientID is the address this client's correlated replies are routed to.
func (t *HTTPTransport) ClientID() string { return t.shared.clientID }

// send gives the stream a command; nothing, once the stream has stopped.
func (t *HTTPTransport) send(c command) {
	select {
	case t.commands <- c:
	case <-t.stopped:
	}
}

// Emit sends one frame. It resolves when the gateway has accepted it, with
// the number of subscribers the frame reached; counted is false when the
// gateway gave no count.
func (t *HTTPTransport) Emit(ctx context.Context, channel bus.Channel, payload map[string]any, envelope Envelope) (int, bool, error) {
	clientID := t.shared.clientID
	body := api.BusEmitRequest{Channel: string(channel), Payload: payload, ClientId: &clientID}
	if envelope.CorrelationID != "" {
		correlationID := envelope.CorrelationID
		body.CorrelationId = &correlationID
	}
	if !envelope.Scope.IsZero() {
		scope := envelope.Scope
		body.Scope = &scope
	}
	ctx, span := emitting(ctx, channel, envelope.Scope)
	defer span.End()
	return t.shared.emit(ctx, body)
}

// Frames is the frames delivered on channel from now on: the listener is
// taken when Frames is called, and let go when the loop over the sequence
// stops or the transport closes. A channel this transport can never deliver
// is refused, as unsubscribed.
func (t *HTTPTransport) Frames(channel bus.Channel) (iter.Seq[Frame], error) {
	if !t.IsSubscribed(channel) && !slices.Contains(bus.ResourceScopedChannels, channel) {
		return nil, &BusRequestError{
			Code:    BusRequestErrorCodeUnsubscribed,
			Message: fmt.Sprintf("this transport's stream does not carry %s: nothing on it can be delivered", channel),
		}
	}
	return t.shared.hub.Frames(channel), nil
}

// IsSubscribed reports whether the stream delivers channel globally: whether
// a reply published there can reach this client.
func (t *HTTPTransport) IsSubscribed(channel bus.Channel) bool {
	return slices.Contains(t.shared.global, channel)
}

// SubscribeToResource takes one hold on a resource's scope. The scope is on
// the stream from its first hold to its last release; release lets this hold
// go, once.
func (t *HTTPTransport) SubscribeToResource(resource api.ResourceId) (release func()) {
	t.holdsMu.Lock()
	t.holds[resource]++
	first := t.holds[resource] == 1
	t.holdsMu.Unlock()
	if first {
		t.send(command{kind: commandAddScope, resource: resource})
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			t.holdsMu.Lock()
			t.holds[resource]--
			last := t.holds[resource] == 0
			if last {
				delete(t.holds, resource)
			}
			t.holdsMu.Unlock()
			if last {
				t.send(command{kind: commandRemoveScope, resource: resource})
			}
		})
	}
}

// TrackReply awaits the reply to correlationID on one of channels. A request
// calls it before it emits, so its reply cannot arrive unawaited.
func (t *HTTPTransport) TrackReply(correlationID string, channels ...bus.Channel) *PendingReply {
	return t.shared.router.Track(correlationID, channels)
}

// State is the connection's state now.
func (t *HTTPTransport) State() ConnectionState { return t.state.Value() }

// StateChanges is the connection's state now and each state it moves to,
// until ctx is done or the loop over it stops. A slow reader may see the
// latest state in place of the ones it missed.
func (t *HTTPTransport) StateChanges(ctx context.Context) iter.Seq[ConnectionState] {
	return t.state.Changes(ctx)
}

// Failures is the failures the transport meets from now on: what a server
// refused, and what the gateway never answered, each as it is returned to
// its caller. The first listener hears every one since the transport was
// made.
func (t *HTTPTransport) Failures() iter.Seq[*TransportError] {
	return t.shared.failures.failures()
}

// Close stops the transport: the state becomes closed, every sequence ends,
// and every request still pending learns no reply will come. It returns once
// every goroutine the transport started has ended. Closing twice is closing
// once.
func (t *HTTPTransport) Close() {
	t.closeOnce.Do(func() { t.send(command{kind: commandClose}) })
	<-t.stopped
}

// renewal is the token to send a request again with once refused was
// refused: the refresher's, asked once. ok is false when there is no
// refresher, or it gives no token or the one refused.
func (s *transportShared) renewal(ctx context.Context, refused string) (string, bool) {
	if s.refresher == nil {
		return "", false
	}
	token, ok := s.refresher.Refresh(ctx)
	if !ok || token == "" || token == refused {
		return "", false
	}
	return token, true
}

// emitted is one emit's answer: the count, when the gateway gave one.
type emitted struct {
	subscribers int
	counted     bool
}

// emit is one emit: POST /bus/emit, each attempt bounded by the emit timeout,
// made again inside the emit budget when a limit refused it, the gateway said
// it will recover, or nothing answered; no sooner than a refusal's
// Retry-After. An emit whose credential is refused is never retried: it is
// sent again once, at once, with a renewed token that is not the one refused.
// Any other refusal is final. A failure is reported on the error stream as it
// is returned; an emit its caller abandoned reports nothing.
func (s *transportShared) emit(ctx context.Context, body api.BusEmitRequest) (int, bool, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return 0, false, s.failures.report(transportErrorWithoutResponse(fmt.Sprintf("an emit on %s that does not serialize: %v", body.Channel, err), TransportErrorCodeError))
	}
	token := s.token.Value()
	renewed := false
	for {
		sent := token
		answer, err := retryWithBackoff(ctx, s.timing.EmitRetry,
			func(ctx context.Context) (emitted, error) { return s.emitOnce(ctx, sent, encoded) },
			func(err error) bool {
				var refused *TransportError
				if !errors.As(err, &refused) || refused.Code == TransportErrorCodeUnauthorized {
					return false
				}
				status, ok := refused.Status()
				if !ok {
					return true
				}
				post := http.MethodPost
				return RetryRuleBoot.Retryable(RetryFacts{Status: &status, Method: &post})
			},
			func(err error) (time.Duration, bool) {
				var refused *TransportError
				if errors.As(err, &refused) {
					return refused.RetryAfter()
				}
				return 0, false
			})
		if err == nil {
			return answer.subscribers, answer.counted, nil
		}
		if ctx.Err() != nil {
			return 0, false, ctx.Err()
		}
		var refused *TransportError
		if errors.As(err, &refused) && refused.Code == TransportErrorCodeUnauthorized && !renewed {
			if fresh, ok := s.renewal(ctx, sent); ok {
				token, renewed = fresh, true
				continue
			}
		}
		if errors.As(err, &refused) {
			s.failures.report(refused)
		}
		return 0, false, err
	}
}

// emitOnce is one attempt of an emit.
func (s *transportShared) emitOnce(ctx context.Context, token string, body []byte) (emitted, error) {
	attempt, cancel := context.WithTimeout(ctx, s.timing.EmitTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(attempt, http.MethodPost, s.baseURL+"/bus/emit", bytes.NewReader(body))
	if err != nil {
		return emitted{}, transportErrorWithoutResponse(fmt.Sprintf("/bus/emit cannot be asked: %v", err), TransportErrorCodeError)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	carryTrace(ctx, request.Header)
	response, err := s.http.Do(request)
	if err != nil {
		if ctx.Err() != nil {
			return emitted{}, ctx.Err()
		}
		return emitted{}, transportErrorWithoutResponse(fmt.Sprintf("/bus/emit got no answer: %v", err), TransportErrorCodeUnavailable)
	}
	defer response.Body.Close()
	answered, readErr := io.ReadAll(response.Body)
	if response.StatusCode < 200 || response.StatusCode > 299 {
		wait, hasWait := RetryAfter(response.Header.Get("Retry-After"))
		detail := string(answered)
		if len(detail) > 500 {
			detail = detail[:500]
		}
		message := fmt.Sprintf("/bus/emit %d", response.StatusCode)
		if detail != "" {
			message = fmt.Sprintf("/bus/emit %d: %s", response.StatusCode, detail)
		}
		return emitted{}, refusal(message, response.StatusCode, wait, hasWait, answered)
	}
	// No count is reported as no count, never as a zero: an absent
	// `subscribers` is the gateway saying it could not count, and an
	// unreadable body says nothing at all.
	var accepted api.BusEmitAccepted
	if readErr != nil || json.Unmarshal(answered, &accepted) != nil || accepted.Subscribers == nil {
		return emitted{}, nil
	}
	return emitted{subscribers: *accepted.Subscribers, counted: true}, nil
}
