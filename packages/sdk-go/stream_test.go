package semiont

// What the conformance suite cannot stage: the window of ids remembered, the
// transitions the state may make, the backoff's bounds, a listener that falls
// behind, and the transport against a stand-in gateway that misbehaves at a
// chosen moment.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

func TestTheIdsRememberedAreTheLastOnesDelivered(t *testing.T) {
	seen := seenIDs{ids: map[string]struct{}{}, capacity: 3}
	for _, id := range []string{"a", "b", "c"} {
		if !seen.remember(id) {
			t.Fatalf("%s is taken as delivered before it was", id)
		}
	}
	if seen.remember("a") {
		t.Error("a frame delivered is delivered again")
	}
	if !seen.remember("d") {
		t.Error("d is taken as delivered before it was")
	}
	if !seen.remember("a") {
		t.Error("the oldest id is still remembered past the window")
	}
	if seen.remember("c") {
		t.Error("c, inside the window, is delivered again")
	}
}

func TestOpenIsLeftOnlyForADropOrAClose(t *testing.T) {
	all := []ConnectionState{ConnectionStateInitial, ConnectionStateConnecting, ConnectionStateOpen, ConnectionStateReconnecting, ConnectionStateDegraded, ConnectionStateUnauthenticated, ConnectionStateClosed}
	for _, to := range all {
		want := to == ConnectionStateReconnecting || to == ConnectionStateClosed
		if allowed(ConnectionStateOpen, to) != want {
			t.Errorf("open to %s allowed: %v", to, !want)
		}
		if allowed(ConnectionStateClosed, to) {
			t.Errorf("closed moves to %s, though it is terminal", to)
		}
	}
}

func TestTheBackoffWaitsBetweenHalfItsCapAndItsCap(t *testing.T) {
	timing := DefaultTiming()
	timing.Reconnect = 100 * time.Millisecond
	timing.MaxReconnect = time.Second
	s := newStream(&transportShared{timing: timing}, NewVariable(ConnectionStateInitial))
	for attempt, limit := range []time.Duration{100, 200, 400, 800, 1000, 1000} {
		limit *= time.Millisecond
		wait := s.backoff()
		if wait < limit/2 || wait > limit {
			t.Errorf("attempt %d waits %v; its cap is %v", attempt, wait, limit)
		}
	}
}

func TestASlowListenerDelaysNoOther(t *testing.T) {
	hub := NewFrameHub()
	slow := hub.Frames(context.Background(), "beckon:focus")
	fast := hub.Frames(context.Background(), "beckon:focus")
	const count = 1000
	for n := range count {
		hub.Deliver(Frame{Channel: "beckon:focus", Payload: json.RawMessage(fmt.Sprintf(`{"n":%d}`, n))})
	}
	hub.Close()
	read := func(frames func(func(Frame) bool)) []string {
		var got []string
		for frame := range frames {
			got = append(got, string(frame.Payload))
		}
		return got
	}
	// The fast listener takes everything while the slow one has taken
	// nothing; then the slow one is given every frame, in order, as well.
	fastGot := read(fast)
	slowGot := read(slow)
	if len(fastGot) != count || len(slowGot) != count {
		t.Fatalf("the listeners took %d and %d frames of %d", len(fastGot), len(slowGot), count)
	}
	for n := range count {
		want := fmt.Sprintf(`{"n":%d}`, n)
		if fastGot[n] != want || slowGot[n] != want {
			t.Fatalf("frame %d is %s and %s", n, fastGot[n], slowGot[n])
		}
	}
}

// stubGateway is a gateway that does what a test tells it to.
type stubGateway struct {
	*httptest.Server
	mu sync.Mutex
	// refusals is the statuses the next subscribes are refused with.
	refusals []int
	// arrived is how many subscribes have arrived.
	arrived int
}

func newStubGateway(t *testing.T) *stubGateway {
	g := &stubGateway{}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/bus/subscribe":
			_, _ = io.Copy(io.Discard, r.Body)
			g.mu.Lock()
			g.arrived++
			var refusal int
			if len(g.refusals) > 0 {
				refusal, g.refusals = g.refusals[0], g.refusals[1:]
			}
			g.mu.Unlock()
			if refusal != 0 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(refusal)
				_, _ = w.Write([]byte(`{"error":"refused"}`))
				return
			}
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case "/bus/emit":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(g.Close)
	return g
}

func (g *stubGateway) subscribes() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.arrived
}

// client is a transport to the stub, with timing a test does not wait out,
// and the HTTP client it was made with.
func (g *stubGateway) client() (*HTTPTransport, *http.Client) {
	timing := DefaultTiming()
	timing.Reconnect = 20 * time.Millisecond
	timing.LazyRemove = 20 * time.Millisecond
	timing.ReconnectDebounce = 10 * time.Millisecond
	timing.Linger = 20 * time.Millisecond
	httpClient := &http.Client{Transport: &http.Transport{}}
	return NewHTTPTransport(HTTPTransportConfig{
		BaseURL:  g.URL,
		Token:    NewVariable("a-token"),
		Channels: []bus.Channel{bus.BeckonFocus.Channel()},
		HTTP:     httpClient,
		Timing:   timing,
	}), httpClient
}

// until waits, up to ten seconds, for probe to hold.
func until(t *testing.T, what string, probe func() bool) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for !probe() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestAListenerTakenAfterTheFirstConnectWasRefusedStillHearsTheRefusal(t *testing.T) {
	gateway := newStubGateway(t)
	gateway.refusals = []int{http.StatusServiceUnavailable}
	transport, _ := gateway.client()
	defer transport.Close()
	// The first connect is refused and the next opens, all before anything
	// listens to the failures: the refusal is reported while no one listens.
	until(t, "the stream to open", func() bool { return transport.State().Value() == ConnectionStateOpen })
	if gateway.subscribes() != 2 {
		t.Fatalf("%d subscribes arrived, want 2", gateway.subscribes())
	}

	heard := make(chan *TransportError, 1)
	go func() {
		for failure := range transport.Failures() {
			heard <- failure
			return
		}
	}()
	select {
	case refused := <-heard:
		status, stated := refused.Status()
		if refused.Code != TransportErrorCodeUnavailable || !stated || status != http.StatusServiceUnavailable {
			t.Errorf("the refusal is heard as %q, %d (%v)", refused.Code, status, stated)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the refusal reported before anything listened is not heard")
	}
}

func TestNothingTheTransportStartedOutlivesClose(t *testing.T) {
	gateway := newStubGateway(t)
	before := runtime.NumGoroutine()
	transport, httpClient := gateway.client()
	frames, err := transport.Frames(context.Background(), bus.BeckonFocus.Channel())
	if err != nil {
		t.Fatal(err)
	}
	listening := make(chan struct{})
	go func() {
		defer close(listening)
		for range frames {
		}
	}()
	until(t, "the stream to open", func() bool { return transport.State().Value() == ConnectionStateOpen })
	// A handoff: a second connection opens beside the first, which lingers.
	release := transport.SubscribeToResource(mustResource(t, "res-1"))
	until(t, "the handoff's connect", func() bool { return gateway.subscribes() == 2 })
	release()

	transport.Close()
	select {
	case <-listening:
	case <-time.After(5 * time.Second):
		t.Fatal("a listener's sequence did not end when the transport closed")
	}
	if transport.State().Value() != ConnectionStateClosed {
		t.Errorf("the state is %s after Close", transport.State().Value())
	}
	httpClient.CloseIdleConnections()
	until(t, "every goroutine the transport started to end", func() bool { return runtime.NumGoroutine() <= before })
}

// mustResource is a test's resource id, made through the kind's rule.
func mustResource(t *testing.T, text string) api.ResourceId {
	t.Helper()
	id, err := api.ParseResourceId(text)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestAChannelTheStreamCannotDeliverIsRefusedAsUnsubscribed(t *testing.T) {
	transport, _ := newStubGateway(t).client()
	defer transport.Close()
	_, err := transport.Frames(context.Background(), bus.BeckonHover.Channel())
	var refused *BusRequestError
	if !errors.As(err, &refused) || refused.Code != BusRequestErrorCodeUnsubscribed {
		t.Errorf("a channel the stream does not carry is refused with %v", err)
	}
}
