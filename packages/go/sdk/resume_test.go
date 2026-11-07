package semiont

// A stream's place in each scope, kept with what the caches keep: never ahead
// of them.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

var (
	keptPerson         = PersonKey("did:web:example.org:users:alice")
	keptPlacesKey      = LastEventIDKey("kb-a", keptPerson)
	keptCacheKey       = CacheKey("kb-a", keptPerson, CacheQueryResource)
	keptAnnotationsKey = CacheKey("kb-a", keptPerson, CacheQueryAnnotations)
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
	kept.Save(resource, "p-res-1-7")
	kept.Save(resource, "p-res-1-8")
	kept.Save(other, "p-res-2-3")
	if _, ok := storage.Get(keptPlacesKey); ok {
		t.Fatal("a place was written when it was reached")
	}
	// Reading what a cache kept, and forgetting it, write no place.
	if _, ok := caches.Get(keptCacheKey); ok {
		t.Fatal("a cache reads what nobody wrote")
	}
	if err := caches.Delete(keptCacheKey); err != nil {
		t.Fatal(err)
	}
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
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-res-1-8", "res-2": "p-res-2-3"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}

	// A later place of one scope leaves the other's as it was.
	kept.Save(other, "p-res-2-4")
	caches.Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-res-1-8", "res-2": "p-res-2-4"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
	// With nothing reached since, a cache's write writes no places: what another client kept meanwhile stays.
	storage.Set(keptPlacesKey, `{"res-9": "p-res-9-1"}`)
	caches.Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-9": "p-res-9-1"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
	if err := caches.Delete(keptCacheKey); err != nil {
		t.Fatal(err)
	}
	if _, ok := storage.Get(keptCacheKey); ok {
		t.Fatal("forgetting what a cache kept left it in the storage beneath")
	}
}

// full is a storage that holds what it has, and takes no write of the cache
// keptCacheKey names.
type full struct{ *MemoryStorage }

func (f full) Set(key, value string) error {
	if key == keptCacheKey {
		return errors.New("the storage is full")
	}
	return f.MemoryStorage.Set(key, value)
}

func TestAPlaceIsWrittenAfterTheCachesOwnWriteSoOneThatFailsLeavesNoPlaceAheadOfIt(t *testing.T) {
	storage := full{NewMemoryStorage()}
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	caches := kept.Storage()
	kept.Save(mustResource(t, "res-1"), "p-res-1-7")
	if err := caches.Set(keptCacheKey, "{}"); err == nil || err.Error() != "the storage is full" {
		t.Fatalf("the cache's failed write said %v", err)
	}
	// The cache kept nothing of what the place names, and no place says it did.
	if _, ok := storage.Get(keptPlacesKey); ok {
		t.Fatal("a place was written though the cache's write failed")
	}
	if err := caches.Set(keptAnnotationsKey, "{}"); err != nil {
		t.Fatal(err)
	}
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-res-1-7"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
}

func TestAPlaceWaitsForTheCachesToBeAtRest(t *testing.T) {
	storage := NewMemoryStorage()
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	caches := kept.Storage()
	atRest := false
	kept.gatedBy(func() bool { return atRest })

	kept.Save(mustResource(t, "res-1"), "p-res-1-7")
	caches.Set(keptCacheKey, "{}")
	// Late, which is safe: the cache that was written may not be the one still taking the event in.
	if _, ok := storage.Get(keptPlacesKey); ok {
		t.Fatal("a place was written while a cache was not at rest")
	}

	atRest = true
	caches.Set(keptAnnotationsKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-res-1-7"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
}

func TestWhatIsKeptUnderTheKeyAndIsNoObjectIsNoPlaces(t *testing.T) {
	storage := NewMemoryStorage()
	for _, stored := range []string{"not json", "[1, 2]", `"p-res-1-1"`, "null"} {
		storage.Set(keptPlacesKey, stored)
		if got := NewCoupledBookmarks(storage, keptPlacesKey).Load(); len(got) != 0 {
			t.Errorf("%s reads as places %v", stored, got)
		}
	}
	// And is written over by the first places that are.
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	kept.Save(mustResource(t, "res-1"), "p-res-1-1")
	kept.Storage().Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-res-1-1"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
}

// A pair that is not a resource's id and a PersistedEventId is no place,
// and the places beside it are kept; one reached is written only if it is a
// PersistedEventId.
func TestAPlaceThatIsNotAResourcesIdAndAPersistedEventsIdIsSkipped(t *testing.T) {
	storage := NewMemoryStorage()
	storage.Set(keptPlacesKey, `{"res-1": 7, "not an id": "p-x-1", "res-3": "p-7", "res-4": "e-res-4-1", "res-2": "p-res-2-3"}`)
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-2": "p-res-2-3"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
	kept.Save(mustResource(t, "res-5"), "p-5")
	kept.Save(mustResource(t, "res-6"), "p-res-6-2")
	kept.Storage().Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-2": "p-res-2-3", "res-6": "p-res-6-2"}); !maps.Equal(got, want) {
		t.Fatalf("places kept %v, want %v", got, want)
	}
}

// recordingGateway records each subscription and each emit it is sent,
// answers no emit, and gives the newest stream what a test sends.
type recordingGateway struct {
	*httptest.Server
	mu            sync.Mutex
	subscriptions []api.BusSubscribeRequest
	emits         []api.BusEmitRequest
	streams       []chan string
}

func newRecordingGateway(t *testing.T) *recordingGateway {
	g := &recordingGateway{}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/bus/emit" {
			var emit api.BusEmitRequest
			if err := json.NewDecoder(r.Body).Decode(&emit); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			g.mu.Lock()
			g.emits = append(g.emits, emit)
			g.mu.Unlock()
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{}`))
			return
		}
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
	g.sendData(id, string(data))
}

// sendData gives the newest stream a bus-event whose data line is data, a
// frame or not.
func (g *recordingGateway) sendData(id, data string) {
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

// emittedOn is the emits the gateway was sent on channel, in order.
func (g *recordingGateway) emittedOn(channel bus.Channel) []api.BusEmitRequest {
	g.mu.Lock()
	defer g.mu.Unlock()
	var on []api.BusEmitRequest
	for _, emit := range g.emits {
		if emit.Channel == string(channel) {
			on = append(on, emit)
		}
	}
	return on
}

// heldBridge is a transport whose frames reach the client's bus only once the
// test lets them: what the stream delivered waits here, in order, where the
// client's refresher cannot take it.
type heldBridge struct {
	*HTTPTransport
	mu      sync.Mutex
	sink    FrameSink
	holding bool
	held    []func(FrameSink)
}

var _ FrameSink = (*heldBridge)(nil)

// holdingFrames is transport, holding every frame it delivers until release.
func holdingFrames(transport *HTTPTransport) *heldBridge {
	return &heldBridge{HTTPTransport: transport, holding: true}
}

func (h *heldBridge) BridgeInto(sink FrameSink) {
	h.mu.Lock()
	h.sink = sink
	h.mu.Unlock()
	h.HTTPTransport.BridgeInto(h)
}

func (h *heldBridge) Deliver(frame Frame) {
	h.pass(func(sink FrameSink) { sink.Deliver(frame) })
}

func (h *heldBridge) DeliverRefusal(refusal *FrameRefusal) {
	h.pass(func(sink FrameSink) { sink.DeliverRefusal(refusal) })
}

// pass hands one delivery to the client's bus, or holds it.
func (h *heldBridge) pass(deliver func(FrameSink)) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.holding {
		h.held = append(h.held, deliver)
		return
	}
	deliver(h.sink)
}

// holds is how many deliveries are held.
func (h *heldBridge) holds() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.held)
}

// release hands what was held to the client's bus, in order, and each
// delivery after it at once.
func (h *heldBridge) release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.holding = false
	for _, deliver := range h.held {
		deliver(h.sink)
	}
	h.held = nil
}

// A place is noted only once the refresher has taken its event (B17). While
// the event waits to be taken, no cache has begun to take it in, so another
// cache's write carries no place for it; once it is taken, the refetch it
// starts holds the place back while it is in flight; and once what the
// refetch answered is kept, the place is written.
func TestAPlaceIsNotWrittenBeforeTheRefresherHasTakenItsEvent(t *testing.T) {
	resource := mustResource(t, "res-1")
	storage := NewMemoryStorage()
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	gateway := newRecordingGateway(t)
	transport := holdingFrames(gateway.transport(kept))
	defer transport.Close()
	client := NewClient(ClientConfig{Transport: transport, Timing: DefaultTiming(), Persistence: &CachePersistence{Storage: kept.Storage(), KbID: "kb-a", PersonKey: keptPerson}})
	kept.CoupleTo(client)
	defer client.Close()
	write := func() {
		t.Helper()
		if err := kept.Storage().Set(keptAnnotationsKey, "{}"); err != nil {
			t.Fatal(err)
		}
	}

	// The client holds the resource, and has kept it; the stream holds its scope.
	client.live.resource.Set(resource, readJSON[api.ResourceDescriptor](t, `{"@context":"https://schema.org","@id":"res-1","name":"One","representations":[]}`))
	until(t, "the resource kept", client.PersistenceSettled)
	defer transport.SubscribeToResource(resource)()
	until(t, "a subscription of the resource's scope", func() bool { _, ok := gateway.asked(1); return ok })

	// A recorded event of the resource, then a passing frame no row of the
	// refresh table reads: once the second is held, the stream has done all it
	// does with the first.
	gateway.send("p-res-1-42", map[string]any{"channel": "yield:updated", "scope": "res-1", "payload": map[string]any{
		"id": "evt-1", "type": "yield:updated", "timestamp": "2026-10-06T00:00:00.000Z", "userId": "did:web:example.org:users:alice",
		"version": 1, "resourceId": "res-1", "payload": map[string]any{}, "metadata": map[string]any{"sequenceNumber": 1},
	}})
	gateway.send("e-1", map[string]any{"channel": "beckon:hover", "payload": map[string]any{}})
	until(t, "both frames held", func() bool { return transport.holds() == 2 })

	// Not yet taken: nothing is fetching and nothing is owed, and the place is
	// not written.
	if !client.PersistenceSettled() {
		t.Fatal("the client is not at rest while the event waits to be taken")
	}
	write()
	if place, written := kept.Load()[resource]; written {
		t.Fatalf("the place %s was written before the refresher took its event", place)
	}

	// Taken: the refetch it starts is in flight, unanswered, and the place is
	// held back.
	transport.release()
	asked := bus.BrowseResourceRequested.Request().Channel()
	until(t, "the refetch asked", func() bool { return len(gateway.emittedOn(asked)) == 1 })
	write()
	if place, written := kept.Load()[resource]; written {
		t.Fatalf("the place %s was written while the refetch its event started was in flight", place)
	}

	// Answered and kept: the place is written with the resource's save.
	refetch := gateway.emittedOn(asked)[0]
	if refetch.CorrelationId == nil {
		t.Fatal("the refetch was asked with no correlation id")
	}
	gateway.send("e-2", map[string]any{"channel": string(bus.BrowseResourceRequested.Result().Channel()), "correlationId": *refetch.CorrelationId, "payload": map[string]any{
		"response": map[string]any{"resource": map[string]any{"@context": "https://schema.org", "@id": "res-1", "name": "One, updated", "representations": []any{}}, "lastSequence": 2},
	}})
	until(t, "the place written once the refetch was kept", func() bool { return kept.Load()[resource] == "p-res-1-42" })
}

func TestAStreamBeginsEachScopeWhereItsBookmarksSayAndTellsThemEachRecordedEventItDelivered(t *testing.T) {
	resource, other := mustResource(t, "res-1"), mustResource(t, "res-2")
	storage := NewMemoryStorage()
	storage.Set(keptPlacesKey, `{"res-1":"p-res-1-41"}`)
	kept := NewCoupledBookmarks(storage, keptPlacesKey)
	gateway := newRecordingGateway(t)
	transport := gateway.transport(kept)
	defer transport.Close()

	heard, err := transport.Frames(context.Background(), bus.MarkAdded.Channel())
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
	if begins, _ := gateway.asked(2); !maps.Equal(begins, map[string]string{"res-1": "p-res-1-41", "res-2": ""}) {
		t.Fatalf("the scopes begin at %v", begins)
	}

	// A recorded event's id is its scope's place, once it has been delivered. A passing frame's is no place.
	gateway.send("p-res-1-42", map[string]any{"channel": "mark:added", "payload": map[string]any{"n": 1}, "scope": "res-1"})
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
		return kept.pending[resource] == "p-res-1-42"
	})
	if stored, _ := storage.Get(keptPlacesKey); stored != `{"res-1":"p-res-1-41"}` {
		t.Fatalf("a place was written before a cache's write: %s", stored)
	}
	kept.Storage().Set(keptCacheKey, "{}")
	if got, want := kept.Load(), placesOf(t, map[string]string{"res-1": "p-res-1-42"}); !maps.Equal(got, want) {
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

// Places kept elsewhere, given to a stream that has begun, are taken up only
// for the scopes it holds no place in; and the stream keeps its places there
// from then on.
func TestPlacesGivenToAStreamAreTakenUpOnlyForTheScopesItHoldsNoPlaceIn(t *testing.T) {
	resource, other := mustResource(t, "res-1"), mustResource(t, "res-2")
	storage := NewMemoryStorage()
	storage.Set(keptPlacesKey, `{"res-1":"p-res-1-41"}`)
	elsewhere := NewMemoryStorage()
	elsewhere.Set(keptPlacesKey, `{"res-1":"p-res-1-99","res-2":"p-res-2-3"}`)

	gateway := newRecordingGateway(t)
	transport := gateway.transport(NewCoupledBookmarks(storage, keptPlacesKey))
	defer transport.Close()
	transport.keepPlaces(NewCoupledBookmarks(elsewhere, keptPlacesKey))
	defer transport.SubscribeToResource(resource)()
	defer transport.SubscribeToResource(other)()
	until(t, "a subscription of both scopes", func() bool { _, ok := gateway.asked(2); return ok })
	if begins, _ := gateway.asked(2); !maps.Equal(begins, map[string]string{"res-1": "p-res-1-41", "res-2": "p-res-2-3"}) {
		t.Fatalf("the scopes begin at %v", begins)
	}

	// A stream made with no bookmarks takes up the places it is given all the same.
	bare := newRecordingGateway(t)
	unkept := bare.transport(nil)
	defer unkept.Close()
	kept := NewCoupledBookmarks(elsewhere, keptPlacesKey)
	unkept.keepPlaces(kept)
	defer unkept.SubscribeToResource(other)()
	until(t, "a subscription of the scope", func() bool { _, ok := bare.asked(1); return ok })
	if begins, _ := bare.asked(1); !maps.Equal(begins, map[string]string{"res-2": "p-res-2-3"}) {
		t.Fatalf("the scope begins at %v", begins)
	}
	bare.send("p-res-2-4", map[string]any{"channel": "mark:added", "payload": map[string]any{"n": 1}, "scope": "res-2"})
	until(t, "the place reached is kept", func() bool {
		kept.mu.Lock()
		defer kept.mu.Unlock()
		return kept.pending[other] == "p-res-2-4"
	})
}
