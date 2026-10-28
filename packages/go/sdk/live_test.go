package semiont_test

// A client's live queries: what watching one holds, what a read gives its
// watchers, and what a client keeps of them.
//
// What each query asks is surface_test.go's, the cache's own rules are
// cache_test.go's, and what an event does to a query is refresher_test.go's.
// This file also holds the knowledge base both of these files script.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"iter"
	"maps"
	"slices"
	"sync"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/semionttest"
)

// settling is long enough for what a test waits not to happen.
const settling = 50 * time.Millisecond

// annotationsRead is the one read of the content transport a live query
// makes, as surface.json names it.
const annotationsRead = "getAnnotations"

// asks is what each live query asks: the requests it makes, by channel, or the
// read of the content transport it makes.
var asks = func() map[semiont.CacheQuery][]string {
	agents := []string{string(bus.BrowseAgentsRequested.Request().Channel())}
	for _, holder := range bus.LimitsOperations {
		agents = append(agents, string(holder.Request().Channel()))
	}
	return map[semiont.CacheQuery][]string{
		semiont.CacheQueryResource:         {string(bus.BrowseResourceRequested.Request().Channel())},
		semiont.CacheQueryAnnotations:      {annotationsRead},
		semiont.CacheQueryAnnotation:       {string(bus.BrowseAnnotationRequested.Request().Channel())},
		semiont.CacheQueryEvents:           {string(bus.BrowseEventsRequested.Request().Channel())},
		semiont.CacheQueryReferencedBy:     {string(bus.GatherReferencedByRequested.Request().Channel())},
		semiont.CacheQueryResources:        {string(bus.BrowseResourcesRequested.Request().Channel())},
		semiont.CacheQueryMatchedResources: {string(bus.MatchResourcesRequested.Request().Channel())},
		semiont.CacheQueryEntityTypes:      {string(bus.BrowseEntityTypesRequested.Request().Channel())},
		semiont.CacheQueryTagSchemas:       {string(bus.BrowseTagSchemasRequested.Request().Channel())},
		semiont.CacheQueryAgents:           agents,
	}
}()

func describing(id, name string) string {
	return `{"@context":"https://schema.org","@id":"` + id + `","name":"` + name + `","representations":[]}`
}

// annotating is an annotation of resource; modified is empty for one never
// modified.
func annotating(id, resource, modified string) string {
	stated := `{"@context":"http://www.w3.org/ns/anno.jsonld","type":"Annotation","id":"` + id + `","motivation":"highlighting","target":"` + resource + `","created":"2026-10-06T00:00:00.000Z"`
	if modified != "" {
		stated += `,"modified":"` + modified + `"`
	}
	return stated + "}"
}

func annotationIdOf(t *testing.T, text string) api.AnnotationId {
	t.Helper()
	id, err := api.ParseAnnotationId(text)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func resourceAnswer(name string) json.RawMessage {
	return json.RawMessage(`{"resource":` + describing("res-1", name) + `,"lastSequence":1}`)
}

// knowing is how a small knowledge base answers each request a live query
// makes, as often as it is asked: a resource or an annotation is res-1's.
func knowing() semionttest.MakeResponse {
	page := `"resources":[],"total":0,"offset":0,"limit":100`
	answers := map[bus.Channel]string{
		bus.BrowseResourceRequested.Request().Channel():     `{"resource":` + describing("res-1", "A resource") + `,"lastSequence":1}`,
		bus.BrowseAnnotationRequested.Request().Channel():   `{"annotation":` + annotating("ann-1", "res-1", "") + `,"resource":null,"resolvedResource":null}`,
		bus.BrowseEventsRequested.Request().Channel():       `{"events":[],"total":0,"resourceId":"res-1"}`,
		bus.GatherReferencedByRequested.Request().Channel(): `{"referencedBy":[]}`,
		bus.BrowseResourcesRequested.Request().Channel():    `{` + page + `}`,
		bus.MatchResourcesRequested.Request().Channel():     `{` + page + `,"matchKind":"lexical"}`,
		bus.BrowseEntityTypesRequested.Request().Channel():  `{"entityTypes":["Person"]}`,
		bus.BrowseTagSchemasRequested.Request().Channel():   `{"tagSchemas":[]}`,
		bus.BrowseAgentsRequested.Request().Channel():       `{"agents":[]}`,
	}
	for _, holder := range bus.LimitsOperations {
		answers[holder.Request().Channel()] = `{"limits":[]}`
	}
	return func(operation bus.Channel, payload json.RawMessage) (json.RawMessage, error) {
		answer, known := answers[operation]
		if !known {
			return semionttest.RefuseUnscriptedOperation(operation, payload)
		}
		return json.RawMessage(answer), nil
	}
}

// refusal is the failure a gateway answers a request of channel with.
func refusal(channel bus.Channel) json.RawMessage {
	return json.RawMessage(`{"code":"rejected","message":"the scripted gateway refuses ` + string(channel) + `"}`)
}

// annotatedContent is a content transport that answers each read of a
// resource's annotations with ann-1, as res-1's, as often as it is asked; or,
// silent, answers none, the read waiting until it is let go. A live query
// makes no other call of it.
type annotatedContent struct {
	*semionttest.InMemoryContent
	silent bool

	mu    sync.Mutex
	reads int
}

func (c *annotatedContent) GetAnnotations(ctx context.Context, _ api.ResourceId) (api.GetAnnotationsResponse, error) {
	c.mu.Lock()
	c.reads++
	c.mu.Unlock()
	var listed api.GetAnnotationsResponse
	if c.silent {
		<-ctx.Done()
		return listed, ctx.Err()
	}
	err := json.Unmarshal([]byte(`{"annotations":[`+annotating("ann-1", "res-1", "")+`],"total":1}`), &listed)
	return listed, err
}

// liveSetup is how a live world's knowledge base answers, and the waits its
// client keeps.
type liveSetup struct {
	// window is the B19 window.
	window time.Duration
	// saveWait is how long a kept cache waits, after its values last changed,
	// before it saves them.
	saveWait time.Duration
	// persistence is where the client keeps its queries; nil for a client
	// that keeps nothing.
	persistence *semiont.CachePersistence
	// silent is a knowledge base that answers no request and no read: the
	// test answers each one itself.
	silent bool
	// opening is a stream that has not opened yet: it begins initial, where
	// the transport otherwise begins open.
	opening bool
}

// liveWorld is a client over a scripted knowledge base.
type liveWorld struct {
	transport *semionttest.FaultyTransport
	content   *annotatedContent
	client    *semiont.Client

	mu sync.Mutex
	// refused is the requests the knowledge base refuses, by channel.
	refused map[bus.Channel]bool
}

func newLiveWorld(t *testing.T, setup liveSetup) *liveWorld {
	t.Helper()
	config := semionttest.FaultyConfig{MakeResponse: knowing()}
	if setup.silent {
		// Every reply is lost on its way: the test answers each request itself.
		config = semionttest.FaultyConfig{
			Schedule:     []semionttest.FaultAction{semionttest.DropReply{}},
			MakeResponse: func(bus.Channel, json.RawMessage) (json.RawMessage, error) { return nil, nil },
		}
	}
	transport := semionttest.NewFaultyTransport(config)
	if setup.opening {
		transport.SetState(semiont.ConnectionStateInitial)
	}
	content := &annotatedContent{InMemoryContent: semionttest.NewInMemoryContent(), silent: setup.silent}
	timing := semiont.DefaultTiming()
	timing.InvalidationWindow = setup.window
	timing.SaveDebounce = setup.saveWait
	client := semiont.NewClient(semiont.ClientConfig{Transport: transport, Content: content, Gateway: &semionttest.StubGateway{}, Timing: timing, Persistence: setup.persistence})
	w := &liveWorld{transport: transport, content: content, client: client, refused: map[bus.Channel]bool{}}
	transport.RefuseWhen(func(operation bus.Channel, _ json.RawMessage) json.RawMessage {
		w.mu.Lock()
		defer w.mu.Unlock()
		if w.refused[operation] {
			return refusal(operation)
		}
		return nil
	})
	t.Cleanup(func() {
		client.Close()
		transport.Close()
	})
	return w
}

// refuse has the knowledge base refuse every request on channel from now on.
func (w *liveWorld) refuse(channel bus.Channel) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.refused[channel] = true
}

// askedMark is how much had been asked at a moment: the requests made, and
// the reads of the content transport.
type askedMark struct{ requests, reads int }

func (w *liveWorld) mark() askedMark {
	requests := w.transport.RequestLog()
	w.content.mu.Lock()
	defer w.content.mu.Unlock()
	return askedMark{requests: len(requests), reads: w.content.reads}
}

// askedSince is how often each request has been made since m, by channel, and
// the content transport read, as annotationsRead.
func (w *liveWorld) askedSince(m askedMark) map[string]int {
	requests := w.transport.RequestLog()
	asked := map[string]int{}
	for _, request := range requests[m.requests:] {
		asked[string(request.Channel)]++
	}
	w.content.mu.Lock()
	defer w.content.mu.Unlock()
	if reads := w.content.reads - m.reads; reads > 0 {
		asked[annotationsRead] = reads
	}
	return asked
}

// asksCome waits for what has been asked since m to be want, and then a while
// for anything more.
func (w *liveWorld) asksCome(t *testing.T, m askedMark, want map[string]int) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); !maps.Equal(w.askedSince(m), want) && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	time.Sleep(settling)
	if got := w.askedSince(m); !maps.Equal(got, want) {
		t.Fatalf("asked %v, want %v", got, want)
	}
}

// everyHolderAsked waits until each key holder has been asked for its models'
// limits. The collaborators are ready as soon as the directory answers, and
// the holders' requests may still be on their way.
func (w *liveWorld) everyHolderAsked(t *testing.T) {
	t.Helper()
	for deadline := time.Now().Add(2 * time.Second); time.Now().Before(deadline); time.Sleep(5 * time.Millisecond) {
		asked := w.askedSince(askedMark{})
		unasked := 0
		for _, operation := range bus.LimitsOperations {
			if asked[string(operation.Request().Channel())] == 0 {
				unasked++
			}
		}
		if unasked == 0 {
			return
		}
	}
	t.Fatal("not every key holder was asked for its models' limits")
}

// reopen drops the stream and opens it again. The refresher reads only the
// latest state, so it is given a while to see the drop.
func (w *liveWorld) reopen() {
	w.transport.SetState(semiont.ConnectionStateReconnecting)
	time.Sleep(settling)
	w.transport.SetState(semiont.ConnectionStateOpen)
}

// answerRequest answers request as the service that answers its operation
// would.
func answerRequest(fake *semionttest.FaultyTransport, request semionttest.RequestLogEntry, response string) {
	replies := bus.Operations[request.Channel]
	fake.Deliver(semiont.Frame{Channel: replies.Result, Envelope: semiont.Envelope{CorrelationID: request.CorrelationID}, Payload: json.RawMessage(`{"response":` + response + `}`)})
}

// refuseRequest answers request with a failure.
func refuseRequest(fake *semionttest.FaultyTransport, request semionttest.RequestLogEntry) {
	replies := bus.Operations[request.Channel]
	fake.Deliver(semiont.Frame{Channel: replies.Failure, Envelope: semiont.Envelope{CorrelationID: request.CorrelationID}, Payload: refusal(request.Channel)})
}

// liveQuery is a live query, whatever it shows.
type liveQuery interface {
	States(ctx context.Context) iter.Seq[semiont.CacheState]
}

// aQuery is a live query, whatever it shows, and a read of it.
type aQuery struct {
	name  string
	query liveQuery
	read  func(ctx context.Context) error
}

func queryOf[T any](name string, q *semiont.Cached[T]) aQuery {
	return aQuery{name: name, query: q, read: func(ctx context.Context) error {
		_, err := q.Fresh(ctx)
		return err
	}}
}

// everything is every live query: of both resources and an annotation of
// each, and of the knowledge base.
func everything(t *testing.T, c *semiont.Client) []aQuery {
	t.Helper()
	var all []aQuery
	for _, resource := range []string{"res-1", "res-2"} {
		id := resourceOf(t, resource)
		all = append(all,
			queryOf("resource "+resource, c.Browse.Resource(id)),
			queryOf("annotations of "+resource, c.Browse.Annotations(id)),
			queryOf("events of "+resource, c.Browse.Events(id)),
			queryOf("references to "+resource, c.Gather.ReferencedBy(id)),
		)
	}
	return append(all,
		queryOf("annotation ann-1", c.Browse.Annotation(resourceOf(t, "res-1"), annotationIdOf(t, "ann-1"))),
		queryOf("annotation ann-2", c.Browse.Annotation(resourceOf(t, "res-2"), annotationIdOf(t, "ann-2"))),
		queryOf("resources", c.Browse.Resources(semiont.ResourceFilters{})),
		queryOf("a search", c.Match.Resources("a search", semiont.ResourceFilters{})),
		queryOf("entity types", c.Browse.EntityTypes()),
		queryOf("tag schemas", c.Browse.TagSchemas()),
		queryOf("agents", c.Browse.Agents()),
	)
}

// eachQuery is one query of each live query the table names, of res-1 and
// its annotation ann-1.
func eachQuery(t *testing.T, c *semiont.Client) map[semiont.CacheQuery]aQuery {
	t.Helper()
	resource, annotation := resourceOf(t, "res-1"), annotationIdOf(t, "ann-1")
	return map[semiont.CacheQuery]aQuery{
		semiont.CacheQueryResource:         queryOf("resource", c.Browse.Resource(resource)),
		semiont.CacheQueryAnnotations:      queryOf("annotations", c.Browse.Annotations(resource)),
		semiont.CacheQueryAnnotation:       queryOf("annotation", c.Browse.Annotation(resource, annotation)),
		semiont.CacheQueryEvents:           queryOf("events", c.Browse.Events(resource)),
		semiont.CacheQueryReferencedBy:     queryOf("references", c.Gather.ReferencedBy(resource)),
		semiont.CacheQueryResources:        queryOf("resources", c.Browse.Resources(semiont.ResourceFilters{})),
		semiont.CacheQueryMatchedResources: queryOf("a search", c.Match.Resources("text", semiont.ResourceFilters{})),
		semiont.CacheQueryEntityTypes:      queryOf("entity types", c.Browse.EntityTypes()),
		semiont.CacheQueryTagSchemas:       queryOf("tag schemas", c.Browse.TagSchemas()),
		semiont.CacheQueryAgents:           queryOf("agents", c.Browse.Agents()),
	}
}

// stateOrEnd is what one pull of a watcher gave.
type stateOrEnd struct {
	state semiont.CacheState
	ok    bool
}

// watcher is one watcher of a live query: its states, pulled one at a time.
type watcher struct {
	next    func() (semiont.CacheState, bool)
	stop    func()
	cancel  context.CancelFunc
	pending chan stateOrEnd
}

// watch is a watcher of query. Its first pull is what asks, and what takes
// the scope the query holds.
func watch(t *testing.T, query liveQuery) *watcher {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	next, stop := iter.Pull(query.States(ctx))
	w := &watcher{next: next, stop: stop, cancel: cancel}
	t.Cleanup(w.close)
	return w
}

func (w *watcher) pull() chan stateOrEnd {
	if w.pending == nil {
		w.pending = make(chan stateOrEnd, 1)
		pending := w.pending
		go func() {
			state, ok := w.next()
			pending <- stateOrEnd{state, ok}
		}()
	}
	return w.pending
}

// now is the state the watcher is given next, which is to be there already or
// soon.
func (w *watcher) now(t *testing.T) semiont.CacheState {
	t.Helper()
	select {
	case got := <-w.pull():
		w.pending = nil
		if !got.ok {
			t.Fatal("the watcher's states ended")
		}
		return got.state
	case <-time.After(2 * time.Second):
		t.Fatal("the watcher was given no state")
		return nil
	}
}

// nothingMore says the watcher is given nothing more now; what it is given
// later is the next now.
func (w *watcher) nothingMore(t *testing.T) {
	t.Helper()
	select {
	case got := <-w.pull():
		w.pending = nil
		t.Fatalf("the watcher was given %#v", got.state)
	case <-time.After(settling):
	}
}

// ended says the watcher's states have ended.
func (w *watcher) ended(t *testing.T) {
	t.Helper()
	select {
	case got := <-w.pull():
		w.pending = nil
		if got.ok {
			t.Fatalf("the watcher was given %#v, after its end", got.state)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the watcher's states did not end")
	}
}

// close lets go of the watcher, and of the scope it held.
func (w *watcher) close() {
	w.cancel()
	if w.pending != nil {
		<-w.pending
		w.pending = nil
	}
	w.stop()
}

// untilReady is the watcher's next value: Pending states before it are passed
// over, and a failure fails the test.
func untilReady(t *testing.T, w *watcher) semiont.CacheState {
	t.Helper()
	for {
		switch state := w.now(t).(type) {
		case semiont.Pending:
		case semiont.Failed:
			t.Fatalf("the query failed: %v", state.Err)
		default:
			return state
		}
	}
}

// untilFailed is the watcher's next failure: Pending states before it are
// passed over, and a value fails the test.
func untilFailed(t *testing.T, w *watcher) semiont.Failed {
	t.Helper()
	for {
		switch state := w.now(t).(type) {
		case semiont.Pending:
		case semiont.Failed:
			return state
		default:
			t.Fatalf("the query has a value, %#v, where a failure was to be", state)
		}
	}
}

func isPending(t *testing.T, state semiont.CacheState) {
	t.Helper()
	if _, ok := state.(semiont.Pending); !ok {
		t.Fatalf("the state is %#v, not pending", state)
	}
}

func valueIn[T any](t *testing.T, state semiont.CacheState) T {
	t.Helper()
	ready, ok := state.(semiont.Ready[T])
	if !ok {
		t.Fatalf("the state is %#v, not a value of %T", state, ready.Value)
	}
	return ready.Value
}

// modifiedOf is when an annotation was last modified; "never" when it was not.
func modifiedOf(annotation api.Annotation) string {
	if annotation.Modified == nil {
		return "never"
	}
	return *annotation.Modified
}

// payloadsOn is the payload of each request of channel, as JSON, in order.
func payloadsOn(fake *semionttest.FaultyTransport, channel bus.Channel) []string {
	var payloads []string
	for _, request := range requestsOn(fake, channel) {
		payloads = append(payloads, string(request.Payload))
	}
	return payloads
}

func TestWatchingAQueryOfAResourceHoldsItsScopeUntilTheWatcherLeaves(t *testing.T) {
	w := newLiveWorld(t, liveSetup{silent: true})
	c := w.client
	res1, res2 := resourceOf(t, "res-1"), resourceOf(t, "res-2")
	query := c.Browse.Events(res1)
	// Naming a query touches nothing.
	time.Sleep(settling)
	if w.transport.Holds(res1) != 0 || len(w.askedSince(askedMark{})) != 0 {
		t.Fatal("naming a query held a scope or asked something")
	}
	live := watch(t, query)
	isPending(t, live.now(t))
	if holds := w.transport.Holds(res1); holds != 1 {
		t.Fatalf("a watcher holds the scope %d times", holds)
	}
	w.asksCome(t, askedMark{}, map[string]int{asks[semiont.CacheQueryEvents][0]: 1})

	// A second watcher, of the same query or of another of the resource, is a second hold.
	more := []*watcher{watch(t, query), watch(t, c.Browse.Annotation(res1, annotationIdOf(t, "ann-1"))), watch(t, c.Gather.ReferencedBy(res2))}
	for _, each := range more {
		each.now(t)
	}
	if one, other := w.transport.Holds(res1), w.transport.Holds(res2); one != 3 || other != 1 {
		t.Fatalf("the scopes are held %d and %d times, want 3 and 1", one, other)
	}
	for _, each := range more {
		each.close()
	}
	if one, other := w.transport.Holds(res1), w.transport.Holds(res2); one != 1 || other != 0 {
		t.Fatalf("the scopes are held %d and %d times, want 1 and 0", one, other)
	}
	live.close()
	if holds := w.transport.Holds(res1); holds != 0 {
		t.Fatalf("the scope is held %d times after its watchers left", holds)
	}

	// Every query of a resource holds its scope while it is watched.
	for _, of := range []aQuery{
		queryOf("resource", c.Browse.Resource(res2)),
		queryOf("annotations", c.Browse.Annotations(res2)),
		queryOf("annotation", c.Browse.Annotation(res2, annotationIdOf(t, "ann-1"))),
		queryOf("events", c.Browse.Events(res2)),
		queryOf("references", c.Gather.ReferencedBy(res2)),
	} {
		watching := watch(t, of.query)
		watching.now(t)
		if holds := w.transport.Holds(res2); holds != 1 {
			t.Fatalf("watching the %s holds its resource's scope %d times", of.name, holds)
		}
		watching.close()
		if holds := w.transport.Holds(res2); holds != 0 {
			t.Fatalf("the %s left holding its resource's scope %d times", of.name, holds)
		}
	}

	// A query of the knowledge base holds no scope, and neither does a read of any query.
	for _, of := range []aQuery{
		queryOf("resources", c.Browse.Resources(semiont.ResourceFilters{})),
		queryOf("a search", c.Match.Resources("text", semiont.ResourceFilters{})),
		queryOf("entity types", c.Browse.EntityTypes()),
		queryOf("tag schemas", c.Browse.TagSchemas()),
		queryOf("agents", c.Browse.Agents()),
	} {
		watch(t, of.query).now(t)
		if holds := w.transport.Holds(res1) + w.transport.Holds(res2); holds != 0 {
			t.Fatalf("watching the %s holds a scope", of.name)
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	res3 := resourceOf(t, "res-3")
	go func() { _, _ = c.Browse.Resource(res3).Fresh(ctx) }()
	waitUntil(t, "the read asked", 2*time.Second, func() bool {
		return slices.Contains(payloadsOn(w.transport, bus.BrowseResourceRequested.Request().Channel()), `{"resourceId":"res-3"}`)
	})
	if holds := w.transport.Holds(res3); holds != 0 {
		t.Fatalf("a read holds the scope %d times", holds)
	}
}

func TestAWatcherThatLeavesEarlyIsNotLeftHoldingAnything(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	res1 := resourceOf(t, "res-1")
	query := w.client.Browse.Resource(res1)
	outer := watch(t, query)
	outer.now(t)
	for range query.States(context.Background()) {
		if holds := w.transport.Holds(res1); holds != 2 {
			t.Fatalf("two watchers hold the scope %d times", holds)
		}
		break
	}
	if holds := w.transport.Holds(res1); holds != 1 {
		t.Fatalf("a watcher that left early still holds: the scope is held %d times", holds)
	}
	outer.close()
	if holds := w.transport.Holds(res1); holds != 0 {
		t.Fatalf("the scope is held %d times after its watchers left", holds)
	}
}

func TestAReadGivesWhatTheServiceAnswersNowAndEveryWatcherIsGivenItToo(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	channel := bus.BrowseResourceRequested.Request().Channel()
	w.transport.QueueReply(channel, resourceAnswer("first"), resourceAnswer("second"))
	res1 := resourceOf(t, "res-1")
	live := watch(t, w.client.Browse.Resource(res1))
	if first := valueIn[api.ResourceDescriptor](t, untilReady(t, live)); first.Name != "first" {
		t.Fatalf("the watcher was shown %q, want first", first.Name)
	}
	// A read asks, whatever is held.
	read, err := w.client.Browse.Resource(res1).Fresh(context.Background())
	if err != nil || read.Name != "second" {
		t.Fatalf("the read gave %q, %v", read.Name, err)
	}
	if second := valueIn[api.ResourceDescriptor](t, live.now(t)); second.Name != "second" {
		t.Fatalf("the watcher was shown %q, want second", second.Name)
	}
	// And fails with the failure it meets, which no watcher is shown: the value stays.
	w.refuse(channel)
	var refused *semiont.BusRequestError
	if _, err := w.client.Browse.Resource(res1).Fresh(context.Background()); !errors.As(err, &refused) {
		t.Fatalf("the read failed with %v, want the service's refusal", err)
	}
	live.nothingMore(t)
	if asked := len(requestsOn(w.transport, channel)); asked != 3 {
		t.Fatalf("asked %d times, want 3", asked)
	}
}

func TestInvalidatingAQueryAsksAgainAndShowsItsValueMeanwhile(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	live := watch(t, w.client.Browse.EntityTypes())
	if types := valueIn[[]string](t, untilReady(t, live)); !slices.Equal(types, []string{"Person"}) {
		t.Fatalf("the watcher was shown %v", types)
	}
	channel := bus.BrowseEntityTypesRequested.Request().Channel()
	w.transport.QueueReply(channel, json.RawMessage(`{"entityTypes":["Person","Place"]}`))
	w.client.Browse.EntityTypes().Invalidate()
	if types := valueIn[[]string](t, live.now(t)); !slices.Equal(types, []string{"Person", "Place"}) {
		t.Fatalf("the watcher was shown %v", types)
	}
	if asked := len(requestsOn(w.transport, channel)); asked != 2 {
		t.Fatalf("asked %d times, want 2", asked)
	}
}

func TestAResourcesAnnotationsAreTheListAndAListOrASearchIsOneQueryPerSetOfFilters(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	c := w.client
	listed, err := c.Browse.Annotations(resourceOf(t, "res-1")).Fresh(context.Background())
	if err != nil || len(listed) != 1 || listed[0].Id.String() != "ann-1" {
		t.Fatalf("the annotations are %v, %v", listed, err)
	}

	archived, person := true, "Person"
	for _, filters := range []semiont.ResourceFilters{{}, {Limit: 100}, {Archived: &archived}, {EntityType: &person}, {Limit: 5}} {
		watch(t, c.Browse.Resources(filters)).now(t)
	}
	lists := bus.BrowseResourcesRequested.Request().Channel()
	waitUntil(t, "the lists asked for", 2*time.Second, func() bool { return len(requestsOn(w.transport, lists)) >= 4 })
	time.Sleep(settling)
	// Stating the limit a list has anyway is the same list.
	asked := payloadsOn(w.transport, lists)
	slices.Sort(asked)
	want := []string{`{"archived":true,"limit":100,"offset":0}`, `{"entityType":"Person","limit":100,"offset":0}`, `{"limit":100,"offset":0}`, `{"limit":5,"offset":0}`}
	if !slices.Equal(asked, want) {
		t.Fatalf("the lists asked for are %v, want %v", asked, want)
	}

	searches := bus.MatchResourcesRequested.Request().Channel()
	notArchived := false
	watch(t, c.Match.Resources("a", semiont.ResourceFilters{})).now(t)
	waitUntil(t, "the first search", 2*time.Second, func() bool { return len(requestsOn(w.transport, searches)) == 1 })
	watch(t, c.Match.Resources("a", semiont.ResourceFilters{})).now(t)
	watch(t, c.Match.Resources("b", semiont.ResourceFilters{Archived: &notArchived})).now(t)
	waitUntil(t, "the second search", 2*time.Second, func() bool { return len(requestsOn(w.transport, searches)) >= 2 })
	time.Sleep(settling)
	searched := payloadsOn(w.transport, searches)
	if want := []string{`{"limit":100,"offset":0,"search":"a"}`, `{"archived":false,"limit":100,"offset":0,"search":"b"}`}; !slices.Equal(searched, want) {
		t.Fatalf("the searches are %v, want %v", searched, want)
	}
}

// namesOf is each collaborator's name.
func namesOf(t *testing.T, collaborators []semiont.Collaborator) []string {
	t.Helper()
	var names []string
	for _, each := range collaborators {
		software, err := each.Entry.Agent.AsAgentSoftware()
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, software.Name)
	}
	return names
}

// limitsOf is the context each collaborator's model was reported to hold;
// "none" for one with no report.
func limitsOf(collaborators []semiont.Collaborator) []string {
	var limits []string
	for _, each := range collaborators {
		if each.Limits == nil {
			limits = append(limits, "none")
			continue
		}
		limits = append(limits, fmt.Sprint(each.Limits.ContextTokens))
	}
	return limits
}

func TestTheCollaboratorsAreShownAsTheDirectoryAnswersAndEachHoldersLimitsAsItReportsThem(t *testing.T) {
	gemma := `{"@type":"Software","name":"gemma","provider":"ollama","model":"gemma2:27b"}`
	claude := `{"@type":"Software","name":"claude","provider":"anthropic","model":"claude-opus-5-5"}`
	w := newLiveWorld(t, liveSetup{silent: true})
	live := watch(t, w.client.Browse.Agents())
	isPending(t, live.now(t))
	// The directory is asked for, and each key holder. The holders are asked as the directory's request is sent, so which reaches the transport first is not stated.
	once := map[string]int{}
	for _, channel := range asks[semiont.CacheQueryAgents] {
		once[channel] = 1
	}
	w.asksCome(t, askedMark{}, once)
	requests := w.transport.RequestLog()
	byChannel := map[bus.Channel]semionttest.RequestLogEntry{}
	for _, request := range requests {
		byChannel[request.Channel] = request
	}
	directory := byChannel[bus.BrowseAgentsRequested.Request().Channel()]
	gather := byChannel[bus.GatherLimitsRequested.Request().Channel()]
	job := byChannel[bus.JobLimitsRequested.Request().Channel()]
	match := byChannel[bus.MatchLimitsRequested.Request().Channel()]

	// A holder that answers before the directory has nothing to be shown on yet.
	answerRequest(w.transport, job, `{"limits":[{"provider":"ollama","model":"gemma2:27b","limits":{"contextTokens":8192,"maxOutputTokens":1}}]}`)
	live.nothingMore(t)

	// The directory is shown when it answers, with what has been reported so far: it waits for no holder.
	answerRequest(w.transport, directory, `{"agents":[{"agent":`+gemma+`},{"agent":`+claude+`}]}`)
	shown := valueIn[[]semiont.Collaborator](t, live.now(t))
	if names, limits := namesOf(t, shown), limitsOf(shown); !slices.Equal(names, []string{"gemma", "claude"}) || !slices.Equal(limits, []string{"8192", "none"}) {
		t.Fatalf("shown %v with limits %v", names, limits)
	}

	// A holder that reports later delays only its own models' limits.
	answerRequest(w.transport, gather, `{"limits":[{"provider":"anthropic","model":"claude-opus-5-5","limits":{"contextTokens":9,"maxOutputTokens":1}}]}`)
	if limits := limitsOf(valueIn[[]semiont.Collaborator](t, live.now(t))); !slices.Equal(limits, []string{"8192", "9"}) {
		t.Fatalf("shown limits %v", limits)
	}

	// And one that fails reports none: nothing changes, and nothing is failed.
	refuseRequest(w.transport, match)
	live.nothingMore(t)
	w.asksCome(t, askedMark{}, once)

	// Asking again asks the directory and every holder again, and shows what there is meanwhile.
	again := w.mark()
	w.client.Browse.Agents().Invalidate()
	w.asksCome(t, again, once)
	live.nothingMore(t)
	var redirectory semionttest.RequestLogEntry
	requests = w.transport.RequestLog()
	for _, request := range requests[again.requests:] {
		if request.Channel == directory.Channel {
			redirectory = request
		}
	}
	answerRequest(w.transport, redirectory, `{"agents":[{"agent":`+claude+`}]}`)
	shown = valueIn[[]semiont.Collaborator](t, live.now(t))
	if names, limits := namesOf(t, shown), limitsOf(shown); !slices.Equal(names, []string{"claude"}) || !slices.Equal(limits, []string{"9"}) {
		t.Fatalf("shown %v with limits %v", names, limits)
	}
}

func TestADirectoryThatFailsIsAFailedStateWhateverItsHoldersReportAndAReadOfItFails(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	directory := bus.BrowseAgentsRequested.Request().Channel()
	w.refuse(directory)
	if _, err := w.client.Browse.Agents().Fresh(context.Background()); err == nil || codeOf(err) != string(semiont.BusRequestErrorCodeRejected) {
		t.Fatalf("the read failed with %v, want the directory's refusal", err)
	}
	live := watch(t, w.client.Browse.Agents())
	if failed := untilFailed(t, live); codeOf(failed.Err) != string(semiont.BusRequestErrorCodeRejected) {
		t.Fatalf("the directory failed with %v, want its refusal", failed.Err)
	}
	live.close()
	// A closed client's collaborators are nobody's to watch.
	w.client.Close()
	watch(t, w.client.Browse.Agents()).ended(t)
}

// keptOf is the one entry of the document a client keeps of the query
// named name: its key, and its value.
func keptOf(t *testing.T, storage semiont.SessionStorage, name string) (key, value json.RawMessage) {
	t.Helper()
	text, ok := storage.Get("semiont.cache.kb." + name)
	if !ok {
		t.Fatalf("nothing is kept of %s", name)
	}
	var document struct {
		Version int                 `json:"version"`
		Entries [][]json.RawMessage `json:"entries"`
	}
	if err := json.Unmarshal([]byte(text), &document); err != nil {
		t.Fatal(err)
	}
	if document.Version != 1 || len(document.Entries) != 1 || len(document.Entries[0]) != 3 {
		t.Fatalf("what is kept of %s is %s", name, text)
	}
	return document.Entries[0][0], document.Entries[0][1]
}

func TestAClientKeepsItsSmallQueriesAndTheNextClientShowsThemAtOnceAndAsksForThemAnew(t *testing.T) {
	storage := semiont.NewMemoryStorage()
	persistence := &semiont.CachePersistence{Storage: storage, KeyPrefix: "kb"}
	// Long enough that every read below is made before the first save is.
	const saveWait = 300 * time.Millisecond
	first := newLiveWorld(t, liveSetup{saveWait: saveWait, persistence: persistence})
	c := first.client
	if !c.PersistenceSettled() {
		t.Fatal("a client that has done nothing is not settled")
	}
	for query, each := range eachQuery(t, c) {
		if err := each.read(context.Background()); err != nil {
			t.Fatalf("the read of %s failed: %v", query, err)
		}
	}
	// What it knows is owed to storage until it has stopped changing.
	if c.PersistenceSettled() {
		t.Fatal("a client that owes a save is settled")
	}
	if _, ok := storage.Get("semiont.cache.kb.resource"); ok {
		t.Fatal("a save was made before the values stopped changing")
	}
	waitUntil(t, "the client settled", 2*time.Second, c.PersistenceSettled)

	// An event about an annotation nobody holds changes nothing the client keeps: nothing is owed.
	first.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkDeleteOk, "", "res-1", "ann-nobody-holds"))
	time.Sleep(settling)
	if !c.PersistenceSettled() {
		t.Fatal("an event about an annotation nobody holds owes a save")
	}
	c.Close()

	// The five small queries, each a document under the client's prefix; a list, a search and a history are not kept.
	for _, name := range []string{"resource", "annotations", "annotation-detail", "entity-types", "tag-schemas"} {
		keptOf(t, storage, name)
	}
	for _, name := range []string{"lists", "resources", "events", "referenced-by", "matched-resources", "searches", "agents", "limits"} {
		if _, ok := storage.Get("semiont.cache.kb." + name); ok {
			t.Fatalf("%s is kept", name)
		}
	}
	// As the wire had it: by the wire's names, and without what the knowledge base never said.
	if key, value := keptOf(t, storage, "resource"); !sameJSON(t, key, []byte(`"res-1"`)) || !sameJSON(t, value, []byte(describing("res-1", "A resource"))) {
		t.Fatalf("the resource is kept as %s: %s", key, value)
	}
	listed := `{"annotations":[` + annotating("ann-1", "res-1", "") + `],"total":1}`
	if key, value := keptOf(t, storage, "annotations"); !sameJSON(t, key, []byte(`"res-1"`)) || !sameJSON(t, value, []byte(listed)) {
		t.Fatalf("the annotations are kept as %s: %s", key, value)
	}

	// The next client of the same knowledge base, over the same storage.
	again := newLiveWorld(t, liveSetup{saveWait: saveWait, persistence: persistence})
	res1 := resourceOf(t, "res-1")
	// Shown at once: no pending before it. And asked for anew, once.
	live := watch(t, again.client.Browse.Resource(res1))
	if shown := valueIn[api.ResourceDescriptor](t, live.now(t)); shown.Name != "A resource" {
		t.Fatalf("the kept resource is shown as %q", shown.Name)
	}
	resource, entityTypes, annotation := asks[semiont.CacheQueryResource][0], asks[semiont.CacheQueryEntityTypes][0], asks[semiont.CacheQueryAnnotation][0]
	again.asksCome(t, askedMark{}, map[string]int{resource: 1})
	types := watch(t, again.client.Browse.EntityTypes())
	if shown := valueIn[[]string](t, types.now(t)); !slices.Equal(shown, []string{"Person"}) {
		t.Fatalf("the kept entity types are shown as %v", shown)
	}
	again.asksCome(t, askedMark{}, map[string]int{resource: 1, entityTypes: 1})
	// An annotation that was kept is asked for anew too, by a request that names its resource.
	one := watch(t, again.client.Browse.Annotation(res1, annotationIdOf(t, "ann-1")))
	valueIn[api.Annotation](t, one.now(t))
	again.asksCome(t, askedMark{}, map[string]int{resource: 1, entityTypes: 1, annotation: 1})
	if asked := payloadsOn(again.transport, bus.Channel(annotation)); asked[0] != `{"annotationId":"ann-1","resourceId":"res-1"}` {
		t.Fatalf("the kept annotation was asked for as %s", asked[0])
	}

	// A client of another knowledge base, over the same storage, begins with nothing of this one's.
	other := newLiveWorld(t, liveSetup{saveWait: saveWait, persistence: &semiont.CachePersistence{Storage: storage, KeyPrefix: "another"}, silent: true})
	isPending(t, watch(t, other.client.Browse.Resource(res1)).now(t))
}

func TestAClientThatKeepsNothingIsAlwaysSettled(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	read := make(chan error, 1)
	go func() {
		_, err := w.client.Browse.Resource(resourceOf(t, "res-1")).Fresh(context.Background())
		read <- err
	}()
	if !w.client.PersistenceSettled() {
		t.Fatal("a client that keeps nothing is not settled while it reads")
	}
	select {
	case err := <-read:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the read did not end")
	}
	if !w.client.PersistenceSettled() {
		t.Fatal("a client that keeps nothing is not settled")
	}
}

func TestAClientIsSettledUnlessAQueryItKeepsIsBeingFetchedOrIsOwedToStorage(t *testing.T) {
	kept := []semiont.CacheQuery{semiont.CacheQueryResource, semiont.CacheQueryAnnotations, semiont.CacheQueryAnnotation, semiont.CacheQueryEntityTypes, semiont.CacheQueryTagSchemas}
	census := newLiveWorld(t, liveSetup{silent: true})
	if named := slices.Sorted(maps.Keys(eachQuery(t, census.client))); !slices.Equal(named, slices.Sorted(slices.Values(semiont.CacheQueries))) {
		t.Fatalf("this test names %v, the table %v", named, semiont.CacheQueries)
	}
	for _, query := range semiont.CacheQueries {
		t.Run(string(query), func(t *testing.T) {
			w := newLiveWorld(t, liveSetup{persistence: &semiont.CachePersistence{Storage: semiont.NewMemoryStorage(), KeyPrefix: "kb"}, silent: true})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			reading := eachQuery(t, w.client)[query]
			go func() { _ = reading.read(ctx) }()
			waitUntil(t, "the read asked", 2*time.Second, func() bool { return w.askedSince(askedMark{})[asks[query][0]] > 0 })
			// Fetching what it keeps, it is not at rest; fetching what it does not keep, it is.
			if settled, want := w.client.PersistenceSettled(), !slices.Contains(kept, query); settled != want {
				t.Fatalf("settled is %v while %s is fetched, want %v", settled, query, want)
			}
		})
	}
}
