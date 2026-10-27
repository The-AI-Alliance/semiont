package semiont

// A stream's place in each scope, kept with what the caches keep: never ahead
// of them. Python's test of a write that fails is not here: a Go
// SessionStorage's Set cannot fail.

import (
	"context"
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

const (
	keptPlacesKey = "semiont.lastEventId.kb-a"
	keptCacheKey  = "semiont.cache.kb-a.resource"
)

func placesOf(t *testing.T, kept map[string]string) map[api.ResourceId]string {
	t.Helper()
	read := map[api.ResourceId]string{}
	for scope, place := range kept {
		read[mustResource(t, scope)] = place
	}
	return read
}

func TestAPlaceIsWrittenWithTheNextWriteOfACacheAndNotBefore(t *testing.T) {
	storage := NewMemoryStorage()
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	caches := kept.Storage()
	if got := kept.Load(); len(got) != 0 {
		t.Fatalf("places kept before any: %v", got)
	}

	resource, other := mustResource(t, "res-1"), mustResource(t, "res-2")
	kept.Save(resource, "p-7")
	kept.Save(resource, "p-8")
	kept.Save(other, "p-3")
	if _, ok := storage.Get(keptPlacesKey); ok {
		t.Fatal("a place was written when it was reached")
	}
	// Reading what a cache kept, and forgetting it, write no place.
	if _, ok := caches.Get(keptCacheKey); ok {
		t.Fatal("a cache reads what nobody wrote")
	}
	caches.Delete(keptCacheKey)
	if _, ok := storage.Get(keptPlacesKey); ok {
		t.Fatal("forgetting what a cache kept wrote a place")
	}

	caches.Set(keptCacheKey, "{}")
	if beneath, _ := storage.Get(keptCacheKey); beneath != "{}" {
		t.Fatalf("the cache's write did not reach the storage beneath: %q", beneath)
	}
	if read, _ := caches.Get(keptCacheKey); read != "{}" {
		t.Fatalf("the cache reads back %q", read)
	}
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-8", "res-2": "p-3"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}

	// A later place of one scope leaves the other's as it was.
	kept.Save(other, "p-4")
	caches.Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-8", "res-2": "p-4"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
	// With nothing reached since, a cache's write writes no places: what another client kept meanwhile stays.
	storage.Set(keptPlacesKey, `{"res-9": "p-1"}`)
	caches.Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-9": "p-1"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
	caches.Delete(keptCacheKey)
	if _, ok := storage.Get(keptCacheKey); ok {
		t.Fatal("forgetting what a cache kept left it in the storage beneath")
	}
}

func TestAPlaceWaitsForTheCachesToBeAtRest(t *testing.T) {
	storage := NewMemoryStorage()
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	caches := kept.Storage()
	atRest := false
	kept.SetFlushGate(func() bool { return atRest })

	kept.Save(mustResource(t, "res-1"), "p-7")
	caches.Set(keptCacheKey, "{}")
	// Late, which is safe: the cache that was written may not be the one still taking the event in.
	if _, ok := storage.Get(keptPlacesKey); ok {
		t.Fatal("a place was written while a cache was not at rest")
	}

	atRest = true
	caches.Set("semiont.cache.kb-a.annotations", "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-7"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
}

func TestWhatIsKeptUnderTheKeyAndIsNotPlacesIsNothingKept(t *testing.T) {
	storage := NewMemoryStorage()
	for _, stored := range []string{"not json", "[1, 2]", `{"res-1": 7}`, `{"not an id": "p-1"}`, "null"} {
		storage.Set(keptPlacesKey, stored)
		if got := NewCoupledBookmarks(storage, keptPlacesKey).Load(); len(got) != 0 {
			t.Errorf("%s reads as places %v", stored, got)
		}
	}
	// And is written over by the first places that are.
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	kept.Save(mustResource(t, "res-1"), "p-1")
	kept.Storage().Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-1"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
}

// recordingGateway records each subscription it is sent, and gives the
// newest stream what a test sends.
type recordingGateway struct {
	*httptest.Server
	mu            sync.Mutex
	subscriptions []api.BusSubscribeRequest
	streams       []chan string
}

func newRecordingGateway(t *testing.T) *recordingGateway {
	g := &recordingGateway{}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/bus/subscribe" {
			http.NotFound(w, r)
			return
		}
		var subscription api.BusSubscribeRequest
		if err := json.NewDecoder(r.Body).Decode(&subscription); err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		sent := make(chan string, 8)
		g.mu.Lock()
		g.subscriptions = append(g.subscriptions, subscription)
		g.streams = append(g.streams, sent)
		g.mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		w.(http.Flusher).Flush()
		for {
			select {
			case <-r.Context().Done():
				return
			case event := <-sent:
				_, _ = fmt.Fprint(w, event)
				w.(http.Flusher).Flush()
			}
		}
	}))
	t.Cleanup(g.Close)
	return g
}

// asked is where the newest subscription of scopes scopes asks each to
// begin: "" for the present.
func (g *recordingGateway) asked(scopes int) (map[string]string, bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for i := len(g.subscriptions) - 1; i >= 0; i-- {
		scoped := g.subscriptions[i].Scoped
		if scoped == nil || len(*scoped) != scopes {
			continue
		}
		begins := map[string]string{}
		for _, entry := range *scoped {
			begins[entry.Scope.String()] = ""
			if entry.LastEventId != nil {
				begins[entry.Scope.String()] = *entry.LastEventId
			}
		}
		return begins, true
	}
	return nil, false
}

// send gives the newest stream a recorded event or a passing frame.
func (g *recordingGateway) send(id string, frame map[string]any) {
	data, err := json.Marshal(frame)
	if err != nil {
		panic(err)
	}
	g.mu.Lock()
	newest := g.streams[len(g.streams)-1]
	g.mu.Unlock()
	newest <- fmt.Sprintf("event: bus-event\nid: %s\ndata: %s\n\n", id, data)
}

func (g *recordingGateway) transport(bookmarks Bookmarks) *HTTPTransport {
	timing := DefaultTiming()
	timing.Reconnect = 10 * time.Millisecond
	timing.LazyRemove = 10 * time.Millisecond
	timing.ReconnectDebounce = 10 * time.Millisecond
	timing.Linger = 10 * time.Millisecond
	return NewHTTPTransport(HTTPTransportConfig{
		BaseURL:   g.URL,
		Token:     NewVariable("t"),
		HTTP:      &http.Client{Transport: &http.Transport{}},
		Timing:    timing,
		Bookmarks: bookmarks,
	})
}

func TestAStreamBeginsEachScopeWhereItsBookmarksSayAndTellsThemEachRecordedEventItDelivered(t *testing.T) {
	resource, other := mustResource(t, "res-1"), mustResource(t, "res-2")
	storage := NewMemoryStorage()
	storage.Set(keptPlacesKey, `{"res-1":"p-41"}`)
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	gateway := newRecordingGateway(t)
	transport := gateway.transport(kept)
	defer transport.Close()

	heard, err := transport.Frames(bus.MarkAdded.Channel())
	if err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithCancel(context.Background())
	defer stop()
	payloads := make(chan string, 2)
	go func() {
		for frame := range heard {
			if ctx.Err() != nil {
				return
			}
			payloads <- string(frame.Payload)
		}
	}()
	defer transport.SubscribeToResource(resource)()
	defer transport.SubscribeToResource(other)()

	// The scope it kept a place in resumes from it; the other begins at the present.
	until(t, "a subscription of both scopes", func() bool { _, ok := gateway.asked(2); return ok })
	if begins, _ := gateway.asked(2); !maps.Equal(begins, map[string]string{"res-1": "p-41", "res-2": ""}) {
		t.Fatalf("the scopes begin at %v", begins)
	}

	// A recorded event's id is its scope's place, once it has been delivered. A passing frame's is no place.
	gateway.send("p-42", map[string]any{"channel": "mark:added", "payload": map[string]any{"n": 1}, "scope": "res-1"})
	gateway.send("e-9", map[string]any{"channel": "mark:added", "payload": map[string]any{"n": 2}, "scope": "res-2"})
	for _, want := range []string{`{"n":1}`, `{"n":2}`} {
		select {
		case got := <-payloads:
			if got != want {
				t.Fatalf("heard %s, want %s", got, want)
			}
		case <-time.After(10 * time.Second):
			t.Fatalf("timed out waiting for %s", want)
		}
	}
	until(t, "the place reached", func() bool {
		kept.mu.Lock()
		defer kept.mu.Unlock()
		return kept.pending[resource] == "p-42"
	})
	if stored, _ := storage.Get(keptPlacesKey); stored != `{"res-1":"p-41"}` {
		t.Fatalf("a place was written before a cache's write: %s", stored)
	}
	kept.Storage().Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-42"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
}

func TestAStreamWithNoBookmarksBeginsEveryScopeAtThePresent(t *testing.T) {
	gateway := newRecordingGateway(t)
	transport := gateway.transport(nil)
	defer transport.Close()
	defer transport.SubscribeToResource(mustResource(t, "res-1"))()
	until(t, "a subscription of the scope", func() bool { _, ok := gateway.asked(1); return ok })
	if begins, _ := gateway.asked(1); !maps.Equal(begins, map[string]string{"res-1": ""}) {
		t.Fatalf("the scope begins at %v", begins)
	}
}
