// Command semiont-go-wire-driver is the Go SDK's wire driver: the program the
// SDK conformance suite talks to in the Go SDK's place
// (tests/conformance/sdk/README.md, § The driver protocol). It holds a
// transport, and reaches it only as an application does, through what the
// SDK exports, so what the suite observes is what a caller of the SDK gets.
//
// An operation the Go SDK cannot do yet is answered unsupported; the suite
// holds the Go SDK exempt from each wire case that asks one
// (tests/conformance/harness/paths.ts).
package main

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/conformance/internal/protocol"
)

// renewals is the refresher a case's renewals give the client: each time it
// is asked, the next of them, made the client's token as a session makes it;
// none once they run out.
type renewals struct {
	mu     sync.Mutex
	tokens []string
	token  *semiont.Watched[string]
}

func (r *renewals) Refresh(context.Context) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.tokens) == 0 {
		return "", false
	}
	renewed := r.tokens[0]
	r.tokens = r.tokens[1:]
	r.token.Set(renewed)
	return renewed, true
}

type client struct {
	token     *semiont.Watched[string]
	transport *semiont.HTTPTransport
	wire      *semiont.Wire
}

type wire struct {
	abandoner protocol.Abandoner

	mu     sync.Mutex
	client *client
	// held is the holds subscribe-resource took, per resource, newest last.
	held map[string][]func()
	// reported is the state last reported.
	reported semiont.ConnectionState
	// reporters is what reports what the client observes; stopReporting ends
	// the ones that do not end with the transport.
	reporters     sync.WaitGroup
	stopReporting context.CancelFunc
}

func (w *wire) Operations() []string {
	return []string{"open", "close", "set-token", "listen", "subscribe-resource", "release-resource", "emit", "request", "abandon", "sync"}
}

func (w *wire) current() (*client, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.client == nil {
		return nil, protocol.Misused("no transport is open")
	}
	return w.client, nil
}

// report reports the state the transport is in, unless it is the one last
// reported.
func (w *wire) report(state semiont.ConnectionState) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.reported != state {
		w.reported = state
		protocol.Say(map[string]string{"state": string(state)})
	}
}

func (w *wire) Run(ctx context.Context, id uint64, op string, args protocol.Arguments) (any, error) {
	switch op {
	case "open":
		return w.open(args)
	case "close":
		c, err := w.current()
		if err != nil {
			return nil, err
		}
		c.transport.Close()
		return nil, nil
	case "set-token":
		c, err := w.current()
		if err != nil {
			return nil, err
		}
		token, err := protocol.Text(args, "token")
		if err != nil {
			return nil, err
		}
		c.token.Set(token)
		return nil, nil
	case "listen":
		return w.listen(args)
	case "subscribe-resource":
		c, err := w.current()
		if err != nil {
			return nil, err
		}
		text, err := protocol.Text(args, "resource")
		if err != nil {
			return nil, err
		}
		resource, err := api.ParseResourceId(text)
		if err != nil {
			return nil, protocol.Misused("resource: %v", err)
		}
		release := c.transport.SubscribeToResource(resource)
		w.mu.Lock()
		w.held[text] = append(w.held[text], release)
		w.mu.Unlock()
		return nil, nil
	case "release-resource":
		text, err := protocol.Text(args, "resource")
		if err != nil {
			return nil, err
		}
		w.mu.Lock()
		holds := w.held[text]
		if len(holds) == 0 {
			w.mu.Unlock()
			return nil, protocol.Misused("nothing holds %s", text)
		}
		release := holds[len(holds)-1]
		w.held[text] = holds[:len(holds)-1]
		w.mu.Unlock()
		release()
		return nil, nil
	case "emit":
		return w.emit(ctx, args)
	case "request":
		return w.request(ctx, args)
	case "abandon":
		request, err := protocol.Count(args, "request")
		if err != nil {
			return nil, err
		}
		if !w.abandoner.Abandon(request) {
			return nil, protocol.Misused("no such request is unsettled")
		}
		return nil, nil
	case "sync":
		// Answers after everything the transport reported before it: the
		// suite's way to know it has read every state the connection was in.
		if c, err := w.current(); err == nil {
			w.report(c.transport.State())
		}
		return nil, nil
	}
	return nil, protocol.Misused("%s is not an operation of this driver", op)
}

// timing is the client's timing, with what the case overrides.
func timing(args protocol.Arguments) (semiont.Timing, error) {
	timing := semiont.DefaultTiming()
	raw, given := args["timing"]
	if !given {
		return timing, nil
	}
	var stated map[string]json.RawMessage
	if json.Unmarshal(raw, &stated) != nil {
		return timing, protocol.Misused("timing must be an object")
	}
	ms := func(name string) (time.Duration, error) {
		n, err := protocol.Count(protocol.Arguments(stated), name)
		return time.Duration(n) * time.Millisecond, err
	}
	for name := range stated {
		var err error
		switch name {
		case "reconnectMs":
			timing.Reconnect, err = ms(name)
		case "lazyRemoveMs":
			timing.LazyRemove, err = ms(name)
		case "lingerMs":
			timing.Linger, err = ms(name)
		case "seenEventIdsCount":
			var n uint64
			n, err = protocol.Count(protocol.Arguments(stated), name)
			timing.SeenEventIdsCount = int(n)
		case "emitRetry":
			var budget map[string]json.RawMessage
			if json.Unmarshal(stated[name], &budget) != nil {
				return timing, protocol.Misused("emitRetry must be an object")
			}
			attempts, err1 := protocol.Count(protocol.Arguments(budget), "attempts")
			initial, err2 := protocol.Count(protocol.Arguments(budget), "initialDelayMs")
			maximum, err3 := protocol.Count(protocol.Arguments(budget), "maxDelayMs")
			for _, e := range []error{err1, err2, err3} {
				if e != nil {
					return timing, e
				}
			}
			timing.EmitRetry = semiont.RetryPolicy{Attempts: int(attempts), InitialDelay: time.Duration(initial) * time.Millisecond, MaxDelay: time.Duration(maximum) * time.Millisecond}
		default:
			return timing, protocol.Misused("this driver cannot override %s", name)
		}
		if err != nil {
			return timing, err
		}
	}
	return timing, nil
}

func (w *wire) open(args protocol.Arguments) (any, error) {
	w.mu.Lock()
	opened := w.client != nil
	w.mu.Unlock()
	if opened {
		return nil, protocol.Misused("a transport is already open")
	}
	timing, err := timing(args)
	if err != nil {
		return nil, err
	}
	baseURL, err := protocol.Text(args, "baseUrl")
	if err != nil {
		return nil, err
	}
	stated, err := protocol.Text(args, "token")
	if err != nil {
		return nil, err
	}
	names, err := protocol.Texts(args, "channels")
	if err != nil {
		return nil, err
	}
	channels := make([]bus.Channel, len(names))
	for i, name := range names {
		channels[i] = bus.Channel(name)
	}
	token := semiont.NewWatched(stated)
	config := semiont.HTTPTransportConfig{BaseURL: baseURL, Token: token, Channels: channels, HTTP: &http.Client{}, Timing: timing}
	if _, given := args["renewals"]; given {
		tokens, err := protocol.Texts(args, "renewals")
		if err != nil {
			return nil, err
		}
		config.Refresher = &renewals{tokens: tokens, token: token}
	}
	transport := semiont.NewHTTPTransport(config)
	// Taken at once, so every failure from the first request on is heard.
	failures := transport.Failures()
	reporting, stop := context.WithCancel(context.Background())
	w.mu.Lock()
	w.client = &client{token: token, transport: transport, wire: semiont.NewWire(transport)}
	w.stopReporting = stop
	w.mu.Unlock()
	w.reporters.Add(2)
	go func() {
		defer w.reporters.Done()
		for state := range transport.StateChanges(reporting) {
			w.report(state)
		}
	}()
	go func() {
		defer w.reporters.Done()
		for failure := range failures {
			protocol.Say(map[string]any{"error": protocol.Failure(failure)})
		}
	}()
	return nil, nil
}

func (w *wire) listen(args protocol.Arguments) (any, error) {
	c, err := w.current()
	if err != nil {
		return nil, err
	}
	channel, err := protocol.Text(args, "channel")
	if err != nil {
		return nil, err
	}
	frames, err := c.transport.Frames(bus.Channel(channel))
	if err != nil {
		return nil, err
	}
	w.reporters.Add(1)
	go func() {
		defer w.reporters.Done()
		for frame := range frames {
			line := map[string]any{"channel": channel, "payload": frame.Payload}
			if frame.CorrelationID != "" {
				line["correlationId"] = frame.CorrelationID
			}
			if !frame.Scope.IsZero() {
				line["scope"] = frame.Scope.String()
			}
			protocol.Say(map[string]any{"frame": line})
		}
	}()
	return nil, nil
}

func (w *wire) emit(ctx context.Context, args protocol.Arguments) (any, error) {
	c, err := w.current()
	if err != nil {
		return nil, err
	}
	channel, err := protocol.Text(args, "channel")
	if err != nil {
		return nil, err
	}
	payload, err := protocol.Object(args, "payload")
	if err != nil {
		return nil, err
	}
	var envelope semiont.Envelope
	if correlationID, ok, err := protocol.OptionalText(args, "correlationId"); err != nil {
		return nil, err
	} else if ok {
		envelope.CorrelationID = correlationID
	}
	if scope, ok, err := protocol.OptionalText(args, "scope"); err != nil {
		return nil, err
	} else if ok {
		resource, err := api.ParseResourceId(scope)
		if err != nil {
			return nil, protocol.Misused("scope: %v", err)
		}
		envelope.Scope = resource
	}
	subscribers, counted, err := c.wire.EmitOn(ctx, bus.Channel(channel), payload, envelope)
	if err != nil {
		return nil, err
	}
	if !counted {
		return map[string]any{}, nil
	}
	return map[string]any{"subscribers": subscribers}, nil
}

func (w *wire) request(ctx context.Context, args protocol.Arguments) (any, error) {
	c, err := w.current()
	if err != nil {
		return nil, err
	}
	name, err := protocol.Text(args, "operation")
	if err != nil {
		return nil, err
	}
	if _, ok := bus.Operations[bus.Channel(name)]; !ok {
		return nil, protocol.Misused("%s is not an operation of the registry", name)
	}
	payload, err := protocol.Object(args, "payload")
	if err != nil {
		return nil, err
	}
	timeout, err := protocol.Count(args, "timeoutMs")
	if err != nil {
		return nil, err
	}
	response, err := c.wire.RequestOf(ctx, bus.Channel(name), payload, time.Duration(timeout)*time.Millisecond)
	if err != nil {
		return nil, err
	}
	if response == nil {
		return map[string]any{}, nil
	}
	return map[string]any{"response": response}, nil
}

func (w *wire) Finish() {
	w.mu.Lock()
	c, stop := w.client, w.stopReporting
	w.mu.Unlock()
	if c != nil {
		c.transport.Close()
		stop()
	}
	w.reporters.Wait()
}

func main() {
	protocol.Serve(func(abandoner protocol.Abandoner) protocol.Driver {
		return &wire{abandoner: abandoner, held: map[string][]func(){}}
	})
}
