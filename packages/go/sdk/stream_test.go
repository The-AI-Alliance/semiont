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
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
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
		hub.Deliver(Frame{Channel: "beckon:focus", Payload: json.RawMessage(fmt.Sprintf(`{"resourceId":"res-1","n":%d}`, n))})
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
		want := fmt.Sprintf(`{"resourceId":"res-1","n":%d}`, n)
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
	// unanswered is how many of the next subscribes are taken and never
	// answered, after any refusals.
	unanswered int
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
			silent := false
			if len(g.refusals) > 0 {
				refusal, g.refusals = g.refusals[0], g.refusals[1:]
			} else if g.unanswered > 0 {
				g.unanswered--
				silent = true
			}
			g.mu.Unlock()
			if silent {
				<-r.Context().Done()
				return
			}
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

// client is a transport to the stub, which cannot renew its token, and the
// HTTP client it was made with.
func (g *stubGateway) client() (*HTTPTransport, *http.Client) {
	return transportTo(g.URL, NewVariable("a-token"), nil)
}

// transportTo is a transport to the gateway at url that holds token and
// renews it with refresher, with timing a test does not wait out, and the
// HTTP client it was made with.
func transportTo(url string, token *Variable[string], refresher TokenRefresher) (*HTTPTransport, *http.Client) {
	timing := DefaultTiming()
	timing.Reconnect = 20 * time.Millisecond
	timing.LazyRemove = 20 * time.Millisecond
	timing.ReconnectDebounce = 10 * time.Millisecond
	timing.Linger = 20 * time.Millisecond
	httpClient := &http.Client{Transport: &http.Transport{}}
	return NewHTTPTransport(HTTPTransportConfig{
		BaseURL:   url,
		Token:     token,
		Refresher: refresher,
		Channels:  []bus.Channel{bus.BeckonFocus.Channel()},
		HTTP:      httpClient,
		Timing:    timing,
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

// An open the gateway takes and never answers has failed once
// StreamOpenTimeout has passed, and the stream is opened again on the
// backoff, as after any open that failed.
func TestAnOpenTheGatewayNeverAnswersFailsAtItsDeadlineAndIsMadeAgain(t *testing.T) {
	gateway := newStubGateway(t)
	gateway.unanswered = 1
	timing := DefaultTiming()
	timing.Reconnect = 20 * time.Millisecond
	timing.StreamOpenTimeout = 200 * time.Millisecond
	transport := NewHTTPTransport(HTTPTransportConfig{
		BaseURL:  gateway.URL,
		Token:    NewVariable("a-token"),
		Channels: []bus.Channel{bus.BeckonFocus.Channel()},
		HTTP:     &http.Client{Transport: &http.Transport{}},
		Timing:   timing,
	})
	defer transport.Close()
	started := time.Now()
	until(t, "the stream to open on the subscribe after the unanswered one", func() bool {
		return transport.State().Value() == ConnectionStateOpen
	})
	if waited := time.Since(started); waited < timing.StreamOpenTimeout {
		t.Errorf("the stream opened %v after it started, before the unanswered open's deadline", waited)
	}
	if gateway.subscribes() != 2 {
		t.Errorf("%d subscribes arrived, want 2", gateway.subscribes())
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

const tokenSent, tokenRenewed = "token-1", "token-2"

// renewedMeanwhile is a gateway that refuses tokenSent on one path, and the
// client's token is renewed to tokenRenewed while that refusal is on its
// way. The client hears the refusal holding a token other than the one
// refused.
type renewedMeanwhile struct {
	*httptest.Server
	token *Variable[string]
	mu    sync.Mutex
	// sent is each request's path and the token it carried.
	sent [][2]string
}

func newRenewedMeanwhile(t *testing.T, refusing string) *renewedMeanwhile {
	g := &renewedMeanwhile{token: NewVariable(tokenSent)}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		bearer := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
		g.mu.Lock()
		g.sent = append(g.sent, [2]string{r.URL.Path, bearer})
		g.mu.Unlock()
		if r.URL.Path == refusing && bearer == tokenSent {
			g.token.Set(tokenRenewed)
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = w.Write([]byte(`{"error":"Invalid token"}`))
			return
		}
		switch r.URL.Path {
		case "/bus/subscribe":
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

// sentOn is the tokens the requests on path carried, in the order they arrived.
func (g *renewedMeanwhile) sentOn(path string) []string {
	g.mu.Lock()
	defer g.mu.Unlock()
	var tokens []string
	for _, sent := range g.sent {
		if sent[0] == path {
			tokens = append(tokens, sent[1])
		}
	}
	return tokens
}

// renewedRefresher answers every refusal with the token the client holds,
// as the refresher of a client whose token was renewed already does. It
// keeps each token it was told was refused.
type renewedRefresher struct {
	token   *Variable[string]
	mu      sync.Mutex
	refused []string
}

func (r *renewedRefresher) Refresh(_ context.Context, refused string) (string, bool) {
	r.mu.Lock()
	r.refused = append(r.refused, refused)
	r.mu.Unlock()
	return r.token.Value(), true
}

func (r *renewedRefresher) told() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.refused)
}

// recordingRoundTrip sends each request with the round trip it wraps, and
// keeps the path of each.
type recordingRoundTrip struct {
	sends http.RoundTripper
	mu    sync.Mutex
	paths []string
}

func (r *recordingRoundTrip) RoundTrip(request *http.Request) (*http.Response, error) {
	r.mu.Lock()
	r.paths = append(r.paths, request.URL.Path)
	r.mu.Unlock()
	return r.sends.RoundTrip(request)
}

func (r *recordingRoundTrip) made() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.paths)
}

func TestATransportMakesItsStreamItsEmitsItsRequestsAndItsContentWithItsCallersClient(t *testing.T) {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		switch r.URL.Path {
		case "/bus/subscribe":
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		case "/bus/emit":
			writeJSON(w, http.StatusAccepted, map[string]any{})
		case "/api/users/me":
			writeJSON(w, http.StatusOK, map[string]any{"did": "did:web:example.org:users:alice", "email": "a@example.com", "domain": "example.org", "name": nil, "image": nil})
		case "/resources/res-1":
			w.Header().Set("Content-Type", "text/plain")
			_, _ = w.Write([]byte("hello"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gateway.Close()
	callers := &recordingRoundTrip{sends: &http.Transport{}}
	transport := NewHTTPTransport(HTTPTransportConfig{
		BaseURL:  gateway.URL,
		Token:    NewVariable(signedToken(1)),
		Channels: []bus.Channel{bus.BeckonFocus.Channel()},
		HTTP:     &http.Client{Transport: callers},
		Timing:   quickTiming(),
	})
	defer transport.Close()

	until(t, "the stream to open", func() bool { return transport.State().Value() == ConnectionStateOpen })
	if _, _, err := transport.Emit(context.Background(), bus.BeckonFocus.Channel(), map[string]any{}, Envelope{}); err != nil {
		t.Fatalf("emit: %v", err)
	}
	if _, err := transport.GetCurrentUser(context.Background()); err != nil {
		t.Fatalf("asked who the token is: %v", err)
	}
	if _, err := NewHTTPContentTransport(transport).GetBinary(context.Background(), mustResource(t, "res-1")); err != nil {
		t.Fatalf("read the content: %v", err)
	}

	made := callers.made()
	for _, path := range []string{"/bus/subscribe", "/bus/emit", "/api/users/me", "/resources/res-1"} {
		if !slices.Contains(made, path) {
			t.Errorf("%s was not made with the caller's client, which made %q", path, made)
		}
	}
}

func TestARefusedEmitTellsItsRefresherTheTokenItSent(t *testing.T) {
	gateway := newRenewedMeanwhile(t, "/bus/emit")
	refresher := &renewedRefresher{token: gateway.token}
	transport, _ := transportTo(gateway.URL, gateway.token, refresher)
	defer transport.Close()

	if _, _, err := transport.Emit(context.Background(), bus.BeckonFocus.Channel(), map[string]any{}, Envelope{}); err != nil {
		t.Fatalf("the emit sent again with the renewed token failed: %v", err)
	}
	if told := refresher.told(); !slices.Equal(told, []string{tokenSent}) {
		t.Errorf("the refresher was told %q was refused, want [%q], the token the emit sent", told, tokenSent)
	}
	if sent := gateway.sentOn("/bus/emit"); !slices.Equal(sent, []string{tokenSent, tokenRenewed}) {
		t.Errorf("the emits carried %q, want [%q %q]", sent, tokenSent, tokenRenewed)
	}
}

func TestARefusedConnectTellsItsRefresherTheTokenItSent(t *testing.T) {
	gateway := newRenewedMeanwhile(t, "/bus/subscribe")
	refresher := &renewedRefresher{token: gateway.token}
	transport, _ := transportTo(gateway.URL, gateway.token, refresher)
	defer transport.Close()

	until(t, "the stream to open", func() bool { return transport.State().Value() == ConnectionStateOpen })
	if told := refresher.told(); !slices.Equal(told, []string{tokenSent}) {
		t.Errorf("the refresher was told %q was refused, want [%q], the token the connect sent", told, tokenSent)
	}
	if sent := gateway.sentOn("/bus/subscribe"); !slices.Equal(sent, []string{tokenSent, tokenRenewed}) {
		t.Errorf("the connects carried %q, want [%q %q]", sent, tokenSent, tokenRenewed)
	}
}
