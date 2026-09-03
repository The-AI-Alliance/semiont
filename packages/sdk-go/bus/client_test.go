package bus

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeGateway scripts /bus/emit + /bus/subscribe the way the real routes
// behave: every frame is `event: bus-event` carrying {channel, payload}, and
// a reply is only produced once a request has been emitted — which is what
// makes the subscribe-before-emit ordering testable.
type fakeGateway struct {
	mu                 sync.Mutex
	emitted            []map[string]any
	replies            chan string // raw SSE frames to write to any open stream
	subscribe          func(r *http.Request)
	subscribedClientID string
}

func newFakeGateway() *fakeGateway { return &fakeGateway{replies: make(chan string, 8)} }

func (f *fakeGateway) server(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/bus/emit", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.emitted = append(f.emitted, body)
		f.mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
	})
	mux.HandleFunc("/bus/subscribe", func(w http.ResponseWriter, r *http.Request) {
		// The real route is POST-only with a JSON subscription matrix
		// (MULTI-RESOURCE-SCOPE) — the GET query form 404s, an empty
		// matrix 400s. Enforcing that here keeps this fake honest about
		// the wire the client must speak.
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		var matrix struct {
			Global   []string `json:"global"`
			ClientID string   `json:"clientId"`
			Scoped   []struct {
				Scope    string   `json:"scope"`
				Channels []string `json:"channels"`
			} `json:"scoped"`
		}
		if err := json.NewDecoder(r.Body).Decode(&matrix); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if len(matrix.Global) == 0 && len(matrix.Scoped) == 0 {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		// CORRELATED-REPLY-ROUTING D5: clientId is REQUIRED on subscribe, and
		// the real gateway 400s without it. The fake refuses too, so a Go
		// client that forgets the field fails here rather than at the P3
		// cutover as "this client silently receives nothing".
		if matrix.ClientID == "" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		f.subscribedClientID = matrix.ClientID
		f.mu.Unlock()
		for _, e := range matrix.Scoped {
			if e.Scope == "" || len(e.Channels) == 0 {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
		}
		if f.subscribe != nil {
			f.subscribe(r)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush() // headers = "subscribed", the client's ordering signal
		for {
			select {
			case <-r.Context().Done():
				return
			case frame := <-f.replies:
				_, _ = io.WriteString(w, frame)
				w.(http.Flusher).Flush()
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func (f *fakeGateway) lastEmit(t *testing.T) map[string]any {
	t.Helper()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.emitted) == 0 {
		t.Fatal("nothing was emitted")
	}
	return f.emitted[len(f.emitted)-1]
}

func frame(channel string, payload map[string]any) string {
	b, _ := json.Marshal(map[string]any{"channel": channel, "payload": payload})
	return fmt.Sprintf("event: bus-event\ndata: %s\n\n", b)
}

func TestRequestCorrelatesReply(t *testing.T) {
	f := newFakeGateway()
	srv := f.server(t)
	c := NewClient(srv.URL, "tok")

	// The reply is produced only after the emit lands — and it must carry the
	// caller's correlationId, so the client had to have subscribed first.
	go func() {
		for i := 0; i < 50; i++ {
			f.mu.Lock()
			n := len(f.emitted)
			f.mu.Unlock()
			if n > 0 {
				cid := f.lastEmit(t)["payload"].(map[string]any)["correlationId"].(string)
				// A stranger's reply on the same channel must be ignored.
				f.replies <- frame("browse:resources-result", map[string]any{"correlationId": "someone-else", "response": "wrong"})
				f.replies <- frame("browse:resources-result", map[string]any{"correlationId": cid, "response": "right"})
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
	}()

	out, err := c.Request(context.Background(), "browse:resources-requested", map[string]any{"limit": 10}, nil)
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	var got struct {
		Response string `json:"response"`
	}
	if err := json.Unmarshal(out, &got); err != nil {
		t.Fatal(err)
	}
	if got.Response != "right" {
		t.Errorf("got %q, want the reply matching our correlationId", got.Response)
	}
	// The request went out on the operation channel with our id attached.
	emit := f.lastEmit(t)
	if emit["channel"] != "browse:resources-requested" {
		t.Errorf("emitted on %v", emit["channel"])
	}
	if _, ok := emit["payload"].(map[string]any)["correlationId"]; !ok {
		t.Error("emit carried no correlationId")
	}
}

func TestRequestSubscribesBeforeEmitting(t *testing.T) {
	// The ordering guarantee: a reply emitted the instant the request lands
	// must still be caught, which is only true if the stream is already open.
	f := newFakeGateway()
	var subscribedFirst bool
	f.subscribe = func(*http.Request) {
		f.mu.Lock()
		subscribedFirst = len(f.emitted) == 0
		f.mu.Unlock()
	}
	srv := f.server(t)
	c := NewClient(srv.URL, "tok")
	go func() {
		for i := 0; i < 50; i++ {
			f.mu.Lock()
			n := len(f.emitted)
			f.mu.Unlock()
			if n > 0 {
				cid := f.lastEmit(t)["payload"].(map[string]any)["correlationId"].(string)
				f.replies <- frame("browse:resource-result", map[string]any{"correlationId": cid})
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	if _, err := c.Request(context.Background(), "browse:resource-requested", map[string]any{}, nil); err != nil {
		t.Fatalf("request: %v", err)
	}
	if !subscribedFirst {
		t.Error("the client emitted before subscribing — a fast reply would be lost")
	}
}

func TestRequestFailureChannelBecomesError(t *testing.T) {
	f := newFakeGateway()
	srv := f.server(t)
	c := NewClient(srv.URL, "tok")
	go func() {
		for i := 0; i < 50; i++ {
			f.mu.Lock()
			n := len(f.emitted)
			f.mu.Unlock()
			if n > 0 {
				cid := f.lastEmit(t)["payload"].(map[string]any)["correlationId"].(string)
				f.replies <- frame("browse:resource-failed", map[string]any{"correlationId": cid, "message": "no such resource"})
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	_, err := c.Request(context.Background(), "browse:resource-requested", map[string]any{}, nil)
	if err == nil {
		t.Fatal("a failure reply must be an error")
	}
	var re *RequestError
	if !strings.Contains(err.Error(), "no such resource") {
		t.Errorf("error lost the gateway's message: %v", err)
	}
	if ok := asRequestError(err, &re); !ok || re.Channel != "browse:resource-failed" {
		t.Errorf("want a RequestError naming the failure channel, got %#v", err)
	}
}

func asRequestError(err error, target **RequestError) bool {
	if re, ok := err.(*RequestError); ok {
		*target = re
		return true
	}
	return false
}

func TestRequestTimesOutHonestly(t *testing.T) {
	f := newFakeGateway()
	srv := f.server(t)
	c := NewClient(srv.URL, "tok")
	_, err := c.Request(context.Background(), "browse:resource-requested", map[string]any{},
		&RequestOptions{Timeout: 150 * time.Millisecond})
	if err == nil {
		t.Fatal("want a timeout")
	}
	// The message must name the channels that stayed silent — a bare
	// "timeout" sends the reader hunting.
	for _, want := range []string{"timed out", "browse:resource-result", "browse:resource-failed"} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("timeout error missing %q: %v", want, err)
		}
	}
}

func TestRequestStreamsProgress(t *testing.T) {
	f := newFakeGateway()
	srv := f.server(t)
	c := NewClient(srv.URL, "tok")
	go func() {
		for i := 0; i < 50; i++ {
			f.mu.Lock()
			n := len(f.emitted)
			f.mu.Unlock()
			if n > 0 {
				cid := f.lastEmit(t)["payload"].(map[string]any)["correlationId"].(string)
				f.replies <- frame("gather:annotation-progress", map[string]any{"correlationId": cid, "step": 1})
				f.replies <- frame("gather:annotation-progress", map[string]any{"correlationId": cid, "step": 2})
				f.replies <- frame("gather:complete", map[string]any{"correlationId": cid})
				return
			}
			time.Sleep(2 * time.Millisecond)
		}
	}()
	var steps int
	_, err := c.Request(context.Background(), "gather:requested", map[string]any{},
		&RequestOptions{Progress: func(Channel, []byte) { steps++ }})
	if err != nil {
		t.Fatalf("request: %v", err)
	}
	if steps != 2 {
		t.Errorf("progress callbacks = %d, want 2", steps)
	}
}

func TestEmitRefusesNonEmittableChannel(t *testing.T) {
	c := NewClient("http://unused", "tok")
	// A domain event is not emittable — the gateway would reject it, so the
	// client refuses rather than making a doomed round trip.
	subscribers, err := c.Emit(context.Background(), "yield:created", map[string]any{}, "")
	if err == nil || !strings.Contains(err.Error(), "not emittable") {
		t.Errorf("want a not-emittable refusal, got %v", err)
	}
	// -1, not 0: the request never left, so "nobody was subscribed" is a claim
	// this client is in no position to make. Zero means the server counted
	// zero; -1 means we never found out.
	if subscribers != -1 {
		t.Errorf("a refused emit must report an UNKNOWN count, got %d", subscribers)
	}
}

func TestReadSSEParsesFrames(t *testing.T) {
	in := strings.NewReader(
		"event: ping\ndata: \n\n" + // keep-alive, ignored
			frame("mark:added", map[string]any{"a": 1}) +
			"event: bus-event\nid: 42\ndata: {\"channel\":\"mark:removed\",\"payload\":{}}\n\n")
	out := make(chan Event, 4)
	if err := readSSE(in, out); err != nil {
		t.Fatal(err)
	}
	close(out)
	var got []Event
	for e := range out {
		got = append(got, e)
	}
	if len(got) != 2 {
		t.Fatalf("parsed %d events, want 2 (the ping must not become one)", len(got))
	}
	if got[0].Channel != "mark:added" || got[1].Channel != "mark:removed" || got[1].ID != "42" {
		t.Errorf("parsed wrong: %+v", got)
	}
}


// CORRELATED-REPLY-ROUTING P2 — the routing address, Go side.

func TestSubscribeAndEmitCarryOneClientID(t *testing.T) {
	f := newFakeGateway()
	srv := f.server(t)
	c := NewClient(srv.URL, "tok")

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	sub, err := c.Subscribe(ctx, []Channel{"browse:resources-result"}, nil, "")
	if err != nil {
		t.Fatalf("subscribe: %v", err)
	}
	defer sub.Close()

	if _, err := c.Emit(ctx, "browse:resources-requested", map[string]any{"correlationId": "c-1"}, ""); err != nil {
		t.Fatalf("emit: %v", err)
	}

	f.mu.Lock()
	subscribed := f.subscribedClientID
	f.mu.Unlock()
	if subscribed == "" {
		t.Fatal("subscribe body carried no clientId")
	}

	emitted, _ := f.lastEmit(t)["clientId"].(string)
	if emitted != subscribed {
		t.Fatalf("emit clientId %q != subscribe clientId %q — one client, one address", emitted, subscribed)
	}
	if payload, ok := f.lastEmit(t)["payload"].(map[string]any); ok {
		if _, leaked := payload["clientId"]; leaked {
			t.Fatal("clientId leaked into payload — it is a wire field, like scope")
		}
	}
}

func TestTwoClientsAreTwoAddresses(t *testing.T) {
	f := newFakeGateway()
	srv := f.server(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	a := NewClient(srv.URL, "tok")
	if _, err := a.Emit(ctx, "browse:resources-requested", map[string]any{}, ""); err != nil {
		t.Fatalf("emit a: %v", err)
	}
	first, _ := f.lastEmit(t)["clientId"].(string)

	b := NewClient(srv.URL, "tok")
	if _, err := b.Emit(ctx, "browse:resources-requested", map[string]any{}, ""); err != nil {
		t.Fatalf("emit b: %v", err)
	}
	second, _ := f.lastEmit(t)["clientId"].(string)

	if first == "" || second == "" {
		t.Fatalf("missing clientId: %q / %q", first, second)
	}
	if first == second {
		t.Fatalf("two clients shared one address %q", first)
	}
}
