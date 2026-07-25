package bus

// client.go — the Go bus client: emit, subscribe (SSE), and the correlated
// request/reply convention. Hand-written; the vocabulary it speaks
// (channels, operations) is generated from specs/src/bus/registry.json.
//
// Wire shape, as the backend implements it (apps/backend/src/routes/bus.ts):
//   POST /bus/emit          {channel, payload, scope?}
//   GET  /bus/subscribe     ?channel=…&scoped=…&scope=…  (SSE, bearer)
//     every frame is `event: bus-event` with `data: {channel, payload, scope?}`
//     — the SSE event name is NOT the channel; the channel is inside the data.
//     `event: ping` frames are keep-alives and carry nothing.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Event is one delivered bus event.
type Event struct {
	Channel Channel
	Payload json.RawMessage
	Scope   string
	ID      string
}

// Client talks to one stack's backend.
type Client struct {
	base  string
	token string
	hc    *http.Client
}

// NewClient targets a backend base URL (e.g. http://localhost:4000) with a
// session token from `semiont login`.
func NewClient(base, token string) *Client {
	return &Client{
		base:  strings.TrimSuffix(base, "/"),
		token: token,
		// No global timeout: SSE connections are long-lived by design, and a
		// client-level timeout would sever them mid-stream. Per-request
		// deadlines ride the context instead.
		hc: &http.Client{},
	}
}

func (c *Client) request(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var rdr *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		rdr = bytes.NewReader(b)
	} else {
		rdr = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	return c.hc.Do(req)
}

// Emit publishes one event. Only channels in ChannelSchemas are accepted by
// the backend; emitting anything else is a client bug, so it is refused here
// rather than at the far end.
func (c *Client) Emit(ctx context.Context, ch Channel, payload any, scope string) error {
	if !ch.Emittable() {
		return fmt.Errorf("channel %q is not emittable (no registered schema)", ch)
	}
	body := map[string]any{"channel": string(ch), "payload": payload}
	if scope != "" {
		body["scope"] = scope
	}
	resp, err := c.request(ctx, http.MethodPost, "/bus/emit", body)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		return fmt.Errorf("emit %s: HTTP %d", ch, resp.StatusCode)
	}
	return nil
}

// Subscription is a live SSE stream. Events closes when the stream ends;
// Err reports why (nil on a clean context cancellation).
type Subscription struct {
	Events <-chan Event
	cancel context.CancelFunc
	errBox chan error
}

// Close ends the subscription.
func (s *Subscription) Close() { s.cancel() }

// Err blocks until the reader goroutine has finished and returns its error.
func (s *Subscription) Err() error { return <-s.errBox }

// Subscribe opens the SSE stream. It returns once the server has ANSWERED
// (response headers received), which is the only "you are subscribed" signal
// the protocol offers — there is no server-side hello frame. Request relies
// on that to establish the stream before emitting, so a reply cannot land
// before anyone is listening.
func (c *Client) Subscribe(ctx context.Context, channels, scoped []Channel, scope string) (*Subscription, error) {
	q := url.Values{}
	for _, ch := range channels {
		q.Add("channel", string(ch))
	}
	for _, ch := range scoped {
		q.Add("scoped", string(ch))
	}
	if scope != "" {
		q.Set("scope", scope)
	}
	if len(channels) == 0 && len(scoped) == 0 {
		return nil, fmt.Errorf("subscribe: at least one channel or scoped channel is required")
	}

	sctx, cancel := context.WithCancel(ctx)
	resp, err := c.request(sctx, http.MethodGet, "/bus/subscribe?"+q.Encode(), nil)
	if err != nil {
		cancel()
		return nil, err
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		return nil, fmt.Errorf("subscribe: HTTP %d", resp.StatusCode)
	}

	events := make(chan Event, 64)
	errBox := make(chan error, 1)
	sub := &Subscription{Events: events, cancel: cancel, errBox: errBox}

	go func() {
		defer close(events)
		defer resp.Body.Close()
		err := readSSE(resp.Body, events)
		if sctx.Err() != nil {
			err = nil // caller closed the subscription; not a failure
		}
		errBox <- err
		close(errBox)
	}()
	return sub, nil
}

// readSSE parses the frame format: `event:`/`data:`/`id:` lines, dispatched
// on a blank line. Only `bus-event` frames carry events; `ping` keep-alives
// are discarded.
func readSSE(r interface{ Read([]byte) (int, error) }, out chan<- Event) error {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024) // events can carry whole resources
	var name, data, id string
	flush := func() {
		defer func() { name, data, id = "", "", "" }()
		if name != "bus-event" || data == "" {
			return
		}
		var frame struct {
			Channel string          `json:"channel"`
			Payload json.RawMessage `json:"payload"`
			Scope   string          `json:"scope"`
		}
		if json.Unmarshal([]byte(data), &frame) != nil {
			return // a frame we cannot parse is not worth killing the stream over
		}
		out <- Event{Channel: Channel(frame.Channel), Payload: frame.Payload, Scope: frame.Scope, ID: id}
	}
	for sc.Scan() {
		line := sc.Text()
		switch {
		case line == "":
			flush()
		case strings.HasPrefix(line, "event:"):
			name = strings.TrimSpace(line[len("event:"):])
		case strings.HasPrefix(line, "data:"):
			// Multi-line data fields concatenate with newlines per the spec.
			chunk := strings.TrimPrefix(line[len("data:"):], " ")
			if data == "" {
				data = chunk
			} else {
				data += "\n" + chunk
			}
		case strings.HasPrefix(line, "id:"):
			id = strings.TrimSpace(line[len("id:"):])
		}
	}
	flush()
	return sc.Err()
}

// RequestError is a reply on an operation's failure channel.
type RequestError struct {
	Channel Channel
	Message string
	Payload json.RawMessage
}

func (e *RequestError) Error() string {
	if e.Message == "" {
		return fmt.Sprintf("bus request rejected on %s", e.Channel)
	}
	return e.Message
}

// RequestOptions tunes one request.
type RequestOptions struct {
	Timeout  time.Duration                         // default 30s, matching the TypeScript busRequest
	Scope    string                                // resource scope, for scoped operations
	Progress func(channel Channel, payload []byte) // streaming ops; may be nil
}

// Request performs the correlated request/reply exchange: subscribe to the
// operation's reply channels FIRST, then emit the request carrying a fresh
// correlationId, then return the first reply bearing that id. This ordering
// is the whole ballgame — emitting first races the subscription and loses
// fast replies.
func (c *Client) Request(ctx context.Context, op Channel, payload map[string]any, opts *RequestOptions) (json.RawMessage, error) {
	spec, ok := Operations[op]
	if !ok {
		return nil, fmt.Errorf("%q is not a request/reply operation", op)
	}
	if opts == nil {
		opts = &RequestOptions{}
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	listen := []Channel{spec.Result, spec.Failure}
	if spec.Streaming() {
		listen = append(listen, spec.Progress)
	}
	sub, err := c.Subscribe(rctx, listen, nil, opts.Scope)
	if err != nil {
		return nil, fmt.Errorf("subscribe for %s: %w", op, err)
	}
	defer sub.Close()

	correlationID := uuid.NewString()
	body := map[string]any{}
	for k, v := range payload {
		body[k] = v
	}
	body["correlationId"] = correlationID
	if err := c.Emit(rctx, op, body, opts.Scope); err != nil {
		return nil, fmt.Errorf("emit %s: %w", op, err)
	}

	for {
		select {
		case <-rctx.Done():
			return nil, fmt.Errorf("%s timed out after %s (no reply on %s or %s)", op, timeout, spec.Result, spec.Failure)
		case ev, open := <-sub.Events:
			if !open {
				return nil, fmt.Errorf("%s: the event stream closed before a reply arrived", op)
			}
			if correlationOf(ev.Payload) != correlationID {
				continue // another caller's reply on the same channel
			}
			switch ev.Channel {
			case spec.Result:
				return ev.Payload, nil
			case spec.Failure:
				return nil, &RequestError{Channel: ev.Channel, Message: messageOf(ev.Payload), Payload: ev.Payload}
			case spec.Progress:
				if opts.Progress != nil {
					opts.Progress(ev.Channel, ev.Payload)
				}
			}
		}
	}
}

func correlationOf(payload json.RawMessage) string {
	var p struct {
		CorrelationID string `json:"correlationId"`
	}
	_ = json.Unmarshal(payload, &p)
	return p.CorrelationID
}

func messageOf(payload json.RawMessage) string {
	var p struct {
		Message string `json:"message"`
		Error   string `json:"error"`
	}
	_ = json.Unmarshal(payload, &p)
	if p.Message != "" {
		return p.Message
	}
	return p.Error
}
