package semiont_test

// What keeps a client's queries true: each row of
// specs/src/client/refresh.json, and the rules every row is applied under.
//
// The conformance corpus holds each row against a real gateway. Here each is
// held against a scripted one, where a test also says what no gateway can be
// made to do on cue: a burst inside a window, an event nobody can read.

import (
	"context"
	"encoding/json"
	"maps"
	"slices"
	"testing"
	"time"

	semiont "github.com/The-AI-Alliance/semiont/packages/sdk-go"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
)

// recordedEvent is an event of the record, as the stream carries it; resource
// is empty for an event of no resource.
func recordedEvent(kind, resource string, payload map[string]any) map[string]any {
	event := map[string]any{
		"id":        "evt-1",
		"type":      kind,
		"timestamp": "2026-10-06T00:00:00.000Z",
		"userId":    "did:web:example.org:users:alice",
		"version":   1,
		"payload":   payload,
		"metadata":  map[string]any{"sequenceNumber": 1},
	}
	if resource != "" {
		event["resourceId"] = resource
	}
	return event
}

func frameOf(t *testing.T, channel bus.Channel, payload any, envelope semiont.Envelope) semiont.Frame {
	t.Helper()
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	return semiont.Frame{Channel: channel, Envelope: envelope, Payload: encoded}
}

// eventOf is an event that is trigger, about resource and its annotation of;
// when is which way a split channel's event comes.
func eventOf(t *testing.T, trigger semiont.CacheRefreshTrigger, when semiont.CacheRefreshWhen, resource, of string) semiont.Frame {
	t.Helper()
	var payload map[string]any
	var envelope semiont.Envelope
	switch trigger {
	case semiont.CacheRefreshBusResumeGap:
		payload = map[string]any{"scope": resource, "lastSeenId": "p-1", "reason": "retention-exceeded"}
	case semiont.CacheRefreshMarkDeleteOk:
		payload = map[string]any{"response": map[string]any{"annotationId": of}}
		envelope.CorrelationID = "cid-delete"
	case semiont.CacheRefreshMarkRemoved:
		payload = recordedEvent(string(trigger), resource, map[string]any{"annotationId": of})
	case semiont.CacheRefreshMarkBodyUpdated:
		payload = recordedEvent(string(trigger), resource, map[string]any{"annotationId": of})
		if when == semiont.CacheRefreshWhenEnriched {
			payload["annotation"] = json.RawMessage(annotating(of, resource, "2026-10-06T01:00:00.000Z"))
		}
	case semiont.CacheRefreshMarkAdded, semiont.CacheRefreshMarkEntityTagAdded, semiont.CacheRefreshMarkEntityTagRemoved,
		semiont.CacheRefreshMarkArchived, semiont.CacheRefreshMarkUnarchived,
		semiont.CacheRefreshYieldCreated, semiont.CacheRefreshYieldUpdated, semiont.CacheRefreshYieldCloned, semiont.CacheRefreshYieldMoved:
		payload = recordedEvent(string(trigger), resource, map[string]any{})
	case semiont.CacheRefreshFrameEntityTypeAdded, semiont.CacheRefreshFrameTagSchemaAdded:
		payload = recordedEvent(string(trigger), "", map[string]any{})
	default:
		t.Fatalf("%s is no event this test can make", trigger)
	}
	return frameOf(t, bus.Channel(trigger), payload, envelope)
}

// ofAResource is the queries everything holds two of: one of each resource,
// or of an annotation of each.
var ofAResource = []semiont.CacheQuery{semiont.CacheQueryResource, semiont.CacheQueryAnnotations, semiont.CacheQueryEvents, semiont.CacheQueryReferencedBy, semiont.CacheQueryAnnotation}

// expectedAsks is what asking again for queries asks, of everything that
// everything holds, when the event is about res-1. A row that reaches its
// subject asks for what is of that resource, and of its annotation: the one
// the event names, or each one held of the resource when it names none, which
// here is the same one.
func expectedAsks(queries []semiont.CacheQuery, reach semiont.CacheRefreshReach) map[string]int {
	asked := map[string]int{}
	for _, query := range queries {
		for _, channel := range asks[query] {
			if reach == semiont.CacheRefreshReachHeld && slices.Contains(ofAResource, query) {
				asked[channel] += 2
			} else {
				asked[channel]++
			}
		}
	}
	return asked
}

func TestEachRowOfTheRefreshTableDoesWhatItStatesToWhatIsHeld(t *testing.T) {
	for _, trigger := range slices.Sorted(maps.Keys(semiont.CacheRefreshTable)) {
		for _, row := range semiont.CacheRefreshTable[trigger] {
			name := string(trigger)
			if row.When != "" {
				name += " " + string(row.When)
			}
			t.Run(name, func(t *testing.T) {
				w := newLiveWorld(t, liveSetup{window: time.Second})
				for _, each := range everything(t, w.client) {
					untilReady(t, watch(t, each.query))
				}
				res1, ann1 := resourceOf(t, "res-1"), annotationIdOf(t, "ann-1")
				one := watch(t, w.client.Browse.Annotation(res1, ann1))
				untilReady(t, one)
				listed := watch(t, w.client.Browse.Annotations(res1))
				untilReady(t, listed)

				m := w.mark()
				if trigger == semiont.CacheRefreshReopened {
					w.reopen()
				} else {
					w.transport.Deliver(eventOf(t, trigger, row.When, "res-1", "ann-1"))
				}
				w.asksCome(t, m, expectedAsks(row.Refetches, row.Reach))

				const modified = "2026-10-06T01:00:00.000Z"
				if slices.Contains(row.Writes, semiont.CacheQueryAnnotation) {
					// The event carried the annotation: it is the value, and nobody was asked.
					if written := valueIn[api.Annotation](t, one.now(t)); written.Id != ann1 || modifiedOf(written) != modified {
						t.Fatalf("the annotation is %s modified %s", written.Id, modifiedOf(written))
					}
				}
				if slices.Contains(row.Writes, semiont.CacheQueryAnnotations) {
					if written := valueIn[[]api.Annotation](t, listed.now(t)); len(written) != 1 || written[0].Id != ann1 || modifiedOf(written[0]) != modified {
						t.Fatalf("the annotations are %v", written)
					}
				}
				if slices.Contains(row.Removes, semiont.CacheQueryAnnotation) {
					failed, ok := one.now(t).(semiont.Failed)
					if !ok || codeOf(failed.Err) != string(semiont.BusRequestErrorCodeNotFound) {
						t.Fatal("the annotation removed is not failed as not found")
					}
				}
				// What this test checks of writes and removes is every one the table states.
				for _, written := range row.Writes {
					if written != semiont.CacheQueryAnnotation && written != semiont.CacheQueryAnnotations {
						t.Fatalf("this test does not check a write of %s", written)
					}
				}
				for _, removed := range row.Removes {
					if removed != semiont.CacheQueryAnnotation {
						t.Fatalf("this test does not check a removal of %s", removed)
					}
				}
			})
		}
	}
}

func TestEveryTriggerButTheReopeningIsAChannelAClientHears(t *testing.T) {
	heard := 0
	for trigger := range semiont.CacheRefreshTable {
		if trigger == semiont.CacheRefreshReopened {
			continue
		}
		heard++
		if channel := bus.Channel(trigger); !bus.Bridged(channel) && !slices.Contains(bus.ResourceScopedChannels, channel) {
			t.Errorf("%s is no channel a client hears", trigger)
		}
	}
	if heard == 0 {
		t.Fatal("the table has no event")
	}
	// And these tests know what each live query asks: a query the table gains is one they must be told of.
	if known, queries := slices.Sorted(maps.Keys(asks)), slices.Sorted(slices.Values(semiont.CacheQueries)); !slices.Equal(known, queries) {
		t.Fatalf("these tests know what %v ask, the table names %v", known, queries)
	}
}

func TestB19TheRefetchesEventsAskOfOneKeyInsideAWindowAreOneRefetch(t *testing.T) {
	const window = 600 * time.Millisecond
	w := newLiveWorld(t, liveSetup{window: window})
	c := w.client
	resources := bus.BrowseResourceRequested.Request().Channel()
	asked := func() int { return len(requestsOn(w.transport, resources)) }
	listsAndSearches := func() [2]int {
		return [2]int{len(requestsOn(w.transport, bus.BrowseResourcesRequested.Request().Channel())), len(requestsOn(w.transport, bus.MatchResourcesRequested.Request().Channel()))}
	}
	updated := func(resource string) {
		w.transport.Deliver(eventOf(t, semiont.CacheRefreshYieldUpdated, "", resource, "ann-1"))
	}
	untilReady(t, watch(t, c.Browse.Resource(resourceOf(t, "res-1"))))
	untilReady(t, watch(t, c.Browse.Resource(resourceOf(t, "res-2"))))
	untilReady(t, watch(t, c.Browse.Resources(semiont.ResourceFilters{})))
	untilReady(t, watch(t, c.Match.Resources("text", semiont.ResourceFilters{})))
	if asked() != 2 || listsAndSearches() != [2]int{1, 1} {
		t.Fatalf("asked %d resources, and %v lists and searches", asked(), listsAndSearches())
	}

	// The first runs at once, and opens the key's window.
	opened := time.Now()
	updated("res-1")
	waitUntil(t, "the first refetch", time.Second, func() bool { return asked() == 3 && listsAndSearches() == [2]int{2, 2} })
	// Any more inside it are owed, and are one.
	for range 5 {
		updated("res-1")
	}
	time.Sleep(settling)
	if asked() != 3 {
		t.Fatalf("asked %d resources inside the window, want 3", asked())
	}
	// A window is one key's: another key's first runs at once. The lists are one key and the searches another,
	// whichever resource an event names: each was asked for again by the first, and owes one more whatever came after.
	updated("res-2")
	waitUntil(t, "another key's refetch", time.Second, func() bool { return asked() == 4 })
	time.Sleep(settling)
	if listsAndSearches() != [2]int{2, 2} {
		t.Fatalf("asked %v lists and searches inside their windows, want 2 and 2", listsAndSearches())
	}

	time.Sleep(time.Until(opened.Add(window - 150*time.Millisecond)))
	if asked() != 4 {
		t.Fatalf("asked %d resources before the window closed, want 4", asked())
	}
	// The window closed: what it owed ran, once, and that opened the next.
	waitUntil(t, "what the window owed", time.Second, func() bool { return asked() == 5 && listsAndSearches() == [2]int{3, 3} })
	if last := payloadsOn(w.transport, resources)[4]; last != `{"resourceId":"res-1"}` {
		t.Fatalf("what the window owed asked %s", last)
	}
	updated("res-1")
	time.Sleep(settling)
	if asked() != 5 {
		t.Fatalf("asked %d resources inside the next window, want 5", asked())
	}
	waitUntil(t, "what the next window owed", 2*window, func() bool { return asked() == 6 })

	// A window that owed nothing closes, and the next event runs at once.
	time.Sleep(window + 150*time.Millisecond)
	if asked() != 6 {
		t.Fatalf("asked %d resources with nothing owed, want 6", asked())
	}
	updated("res-1")
	waitUntil(t, "the refetch, at once", window/2, func() bool { return asked() == 7 })

	// What a window owes when the client closes is dropped.
	updated("res-1")
	time.Sleep(settling)
	c.Close()
	time.Sleep(window + 150*time.Millisecond)
	if asked() != 7 {
		t.Fatalf("asked %d resources after the client closed, want 7", asked())
	}
}

func TestB20AnEventAsksAgainOnlyForWhatTheCacheHolds(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	// Nothing is held: no event of any kind asks for anything.
	for trigger := range semiont.CacheRefreshTable {
		if trigger != semiont.CacheRefreshReopened {
			w.transport.Deliver(eventOf(t, trigger, "", "res-1", "ann-1"))
		}
	}
	w.reopen()
	w.asksCome(t, askedMark{}, map[string]int{})
	if emits, _ := w.transport.Sent(); len(emits) != 0 {
		t.Fatalf("sent %v", emits)
	}

	untilReady(t, watch(t, w.client.Browse.Events(resourceOf(t, "res-1"))))
	m := w.mark()
	// Of what mark:added names, the events are held and the annotations are not; and no other resource's are.
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkAdded, "", "res-1", "ann-1"))
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkAdded, "", "res-2", "ann-1"))
	events := asks[semiont.CacheQueryEvents][0]
	w.asksCome(t, m, map[string]int{events: 1})
	if asked := payloadsOn(w.transport, bus.Channel(events)); asked[len(asked)-1] != `{"resourceId":"res-1"}` {
		t.Fatalf("asked %s", asked[len(asked)-1])
	}
}

func TestB20AKeyThatIsFailedOrBeingFetchedIsHeld(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	events := bus.BrowseEventsRequested.Request().Channel()
	w.transport.Rejections[events] = refusal(events)
	res1 := resourceOf(t, "res-1")
	failing := watch(t, w.client.Browse.Events(res1))
	untilFailed(t, failing)
	w.asksCome(t, askedMark{}, map[string]int{string(events): 2})
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkAdded, "", "res-1", "ann-1"))
	// Asked again, and once more when that failed.
	untilFailed(t, failing)
	w.asksCome(t, askedMark{}, map[string]int{string(events): 4})

	// One whose first request nobody has answered.
	unanswered := newLiveWorld(t, liveSetup{silent: true})
	isPending(t, watch(t, unanswered.client.Browse.Events(res1)).now(t))
	unanswered.asksCome(t, askedMark{}, map[string]int{string(events): 1})
	unanswered.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkAdded, "", "res-1", "ann-1"))
	unanswered.asksCome(t, askedMark{}, map[string]int{string(events): 2})
}

func TestAnEventThatCannotBeReadAsksAgainForEverythingHeld(t *testing.T) {
	w := newLiveWorld(t, liveSetup{window: time.Second})
	for _, each := range everything(t, w.client) {
		untilReady(t, watch(t, each.query))
	}
	// Something changed and nothing says what.
	m := w.mark()
	w.transport.Deliver(frameOf(t, bus.MarkAdded.Channel(), map[string]any{"not": "a recorded event"}, semiont.Envelope{}))
	w.asksCome(t, m, expectedAsks(semiont.CacheQueries, semiont.CacheRefreshReachHeld))
	// And a frame on a channel that is no trigger asks for nothing.
	m = w.mark()
	w.transport.Deliver(frameOf(t, bus.BeckonFocus.Channel(), map[string]any{"annotationId": "ann-1"}, semiont.Envelope{}))
	w.asksCome(t, m, map[string]int{})
}

func TestB13OnlyAStreamThatLeftOpenAndReturnedHasReopened(t *testing.T) {
	w := newLiveWorld(t, liveSetup{opening: true})
	entityTypes := bus.BrowseEntityTypesRequested.Request().Channel()
	asked := func() int { return len(requestsOn(w.transport, entityTypes)) }

	// Its first opening is no reopening: nothing was missed. What was watched before it waits for it, and asks once.
	live := watch(t, w.client.Browse.EntityTypes())
	isPending(t, live.now(t))
	w.transport.SetState(semiont.ConnectionStateConnecting)
	time.Sleep(settling)
	if asked() != 0 {
		t.Fatalf("asked %d times before the stream opened", asked())
	}
	w.transport.SetState(semiont.ConnectionStateOpen)
	if types := valueIn[[]string](t, untilReady(t, live)); !slices.Equal(types, []string{"Person"}) {
		t.Fatalf("the entity types are %v", types)
	}
	time.Sleep(settling)
	if asked() != 1 {
		t.Fatalf("asked %d times once the stream first opened, want 1", asked())
	}

	// Down, and a failed attempt to return, and then back: one reopening.
	for _, state := range []semiont.ConnectionState{semiont.ConnectionStateReconnecting, semiont.ConnectionStateConnecting, semiont.ConnectionStateReconnecting, semiont.ConnectionStateConnecting} {
		w.transport.SetState(state)
		time.Sleep(settling)
	}
	if asked() != 1 {
		t.Fatalf("asked %d times while the stream was down, want 1", asked())
	}
	w.transport.SetState(semiont.ConnectionStateOpen)
	waitUntil(t, "the reopening's refetch", time.Second, func() bool { return asked() == 2 })
	time.Sleep(settling)
	if asked() != 2 {
		t.Fatalf("asked %d times once the stream reopened, want 2", asked())
	}

	// And each drop after it is another.
	w.reopen()
	waitUntil(t, "the next reopening's refetch", time.Second, func() bool { return asked() == 3 })
	time.Sleep(settling)
	if asked() != 3 {
		t.Fatalf("asked %d times once the stream reopened again, want 3", asked())
	}
}

func TestB13bAnEventThatCarriesAnAnnotationWritesItWhereItWasOrAtTheEndAndAsksNothing(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	res1, ann1 := resourceOf(t, "res-1"), annotationIdOf(t, "ann-1")
	listed := watch(t, w.client.Browse.Annotations(res1))
	untilReady(t, listed)
	before := w.mark()
	shownAs := func(annotations []api.Annotation) []string {
		var shown []string
		for _, each := range annotations {
			shown = append(shown, each.Id.String()+" "+modifiedOf(each))
		}
		return shown
	}

	// One the list does not hold is added at its end, and is then an annotation the client holds.
	added := recordedEvent(string(semiont.CacheRefreshMarkBodyUpdated), "res-1", map[string]any{"annotationId": "ann-new"})
	added["annotation"] = json.RawMessage(annotating("ann-new", "res-1", "2026-10-06T02:00:00.000Z"))
	w.transport.Deliver(frameOf(t, bus.MarkBodyUpdated.Channel(), added, semiont.Envelope{}))
	if shown := shownAs(valueIn[[]api.Annotation](t, listed.now(t))); !slices.Equal(shown, []string{"ann-1 never", "ann-new 2026-10-06T02:00:00.000Z"}) {
		t.Fatalf("the list is %v", shown)
	}
	// One it holds is replaced where it was.
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkBodyUpdated, semiont.CacheRefreshWhenEnriched, "res-1", "ann-1"))
	if shown := shownAs(valueIn[[]api.Annotation](t, listed.now(t))); !slices.Equal(shown, []string{"ann-1 2026-10-06T01:00:00.000Z", "ann-new 2026-10-06T02:00:00.000Z"}) {
		t.Fatalf("the list is %v", shown)
	}
	w.asksCome(t, before, map[string]int{})

	// The annotation it carried is the value of that annotation's own query, though nobody had asked for it.
	one := watch(t, w.client.Browse.Annotation(res1, ann1))
	if written := valueIn[api.Annotation](t, one.now(t)); modifiedOf(written) != "2026-10-06T01:00:00.000Z" {
		t.Fatalf("the annotation was modified %s", modifiedOf(written))
	}
	w.asksCome(t, before, map[string]int{})

	// And the annotation the first event carried is one of its resource's, though no query of it was ever named:
	// what is asked again of the resource's annotations is asked of it too, by a request that names the resource.
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshBusResumeGap, "", "res-1", "ann-1"))
	annotation := bus.BrowseAnnotationRequested.Request().Channel()
	waitUntil(t, "ann-new asked for again", time.Second, func() bool {
		return slices.Contains(payloadsOn(w.transport, annotation), `{"annotationId":"ann-new","resourceId":"res-1"}`)
	})
	time.Sleep(settling)
	before = w.mark()

	// An event about a resource whose list is not held writes no list.
	elsewhere := recordedEvent(string(semiont.CacheRefreshMarkBodyUpdated), "res-2", map[string]any{"annotationId": "ann-2"})
	elsewhere["annotation"] = json.RawMessage(annotating("ann-2", "res-2", ""))
	w.transport.Deliver(frameOf(t, bus.MarkBodyUpdated.Channel(), elsewhere, semiont.Envelope{}))
	w.asksCome(t, before, map[string]int{})
	// Its first watcher is shown what the knowledge base answers, never the annotation the event carried.
	if ready, ok := watch(t, w.client.Browse.Annotations(resourceOf(t, "res-2"))).now(t).(semiont.Ready[[]api.Annotation]); ok {
		if shown := shownAs(ready.Value); slices.Contains(shown, "ann-2 never") {
			t.Fatalf("the list of a resource whose list was not held is %v", shown)
		}
	}
}

func TestB13aAnAnnotationThatIsGoneEndsAsNotFoundAndItsNextWatcherAsksNamingItsResource(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	res1, ann1 := resourceOf(t, "res-1"), annotationIdOf(t, "ann-1")
	one := watch(t, w.client.Browse.Annotation(res1, ann1))
	untilReady(t, one)
	annotation := bus.BrowseAnnotationRequested.Request().Channel()
	asked := len(requestsOn(w.transport, annotation))

	// One nobody holds is nobody's to end.
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkDeleteOk, "", "res-1", "ann-2"))
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkDeleteOk, "", "res-1", "ann-1"))
	failed, ok := one.now(t).(semiont.Failed)
	if !ok || codeOf(failed.Err) != string(semiont.BusRequestErrorCodeNotFound) || failed.Err.Error() != "Annotation ann-1 was removed" {
		t.Fatalf("the annotation removed is %#v", failed)
	}
	time.Sleep(settling)
	if now := len(requestsOn(w.transport, annotation)); now != asked {
		t.Fatalf("asked %d times after the removal, want %d", now, asked)
	}

	// Which resource it was of is kept, so the request an arriving watcher makes can name it.
	watch(t, w.client.Browse.Annotation(res1, ann1)).now(t)
	if _, failed := one.now(t).(semiont.Failed); failed {
		t.Fatal("the annotation is still failed once a watcher arrived")
	}
	waitUntil(t, "the arriving watcher's request", time.Second, func() bool { return len(requestsOn(w.transport, annotation)) == asked+1 })
	if last := payloadsOn(w.transport, annotation)[asked]; last != `{"annotationId":"ann-1","resourceId":"res-1"}` {
		t.Fatalf("the arriving watcher asked %s", last)
	}
}

func TestAnEventThatNamesAnAnnotationAsksForThatOneAndOneThatNamesNoneForEachHeldOfItsResource(t *testing.T) {
	w := newLiveWorld(t, liveSetup{})
	annotation := bus.BrowseAnnotationRequested.Request().Channel()
	askedFor := func(since int) []string {
		var named []string
		for _, request := range requestsOn(w.transport, annotation)[since:] {
			named = append(named, request.Payload["annotationId"].(string))
		}
		slices.Sort(named)
		return named
	}

	// Two annotations of one resource, and one of another.
	for _, held := range [][2]string{{"res-1", "ann-1"}, {"res-1", "ann-3"}, {"res-2", "ann-2"}} {
		untilReady(t, watch(t, w.client.Browse.Annotation(resourceOf(t, held[0]), annotationIdOf(t, held[1]))))
	}
	settled := func() int {
		time.Sleep(settling)
		return len(requestsOn(w.transport, annotation))
	}

	// Its body was updated, and the event does not carry it: that annotation is asked for, and no other.
	since := settled()
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshMarkBodyUpdated, semiont.CacheRefreshWhenUnenriched, "res-1", "ann-1"))
	waitUntil(t, "the annotation named asked for", time.Second, func() bool { return len(askedFor(since)) >= 1 })
	time.Sleep(settling)
	if named := askedFor(since); !slices.Equal(named, []string{"ann-1"}) {
		t.Fatalf("asked for %v", named)
	}

	// The stream missed what was recorded of the resource: each annotation held of it is asked for, and no other resource's.
	since = settled()
	w.transport.Deliver(eventOf(t, semiont.CacheRefreshBusResumeGap, "", "res-1", "ann-1"))
	waitUntil(t, "the annotations held asked for", time.Second, func() bool { return len(askedFor(since)) >= 2 })
	time.Sleep(settling)
	if named := askedFor(since); !slices.Equal(named, []string{"ann-1", "ann-3"}) {
		t.Fatalf("asked for %v", named)
	}
}

func TestClosingAClientEndsEveryQuerysWatcherAndFailsEveryReadStillWaitingAsClosed(t *testing.T) {
	// The knowledge base has answered nothing when the client closes: every watcher is pending, and every read waiting.
	w := newLiveWorld(t, liveSetup{silent: true})
	queries := everything(t, w.client)
	var watching []*watcher
	for _, each := range queries {
		live := watch(t, each.query)
		isPending(t, live.now(t))
		watching = append(watching, live)
	}
	reads := make([]chan error, len(queries))
	for i, each := range queries {
		reads[i] = make(chan error, 1)
		go func() { reads[i] <- each.read(context.Background()) }()
	}
	time.Sleep(settling)
	w.client.Close()
	for _, live := range watching {
		live.ended(t)
	}
	for i, read := range reads {
		select {
		case err := <-read:
			if err == nil || codeOf(err) != string(semiont.BusRequestErrorCodeClosed) {
				t.Fatalf("the read of the %s ended with %v, want bus.closed", queries[i].name, err)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("the read of the %s did not end", queries[i].name)
		}
	}
	// Each watcher's hold on its resource's scope is let go once its states end, whatever became of the client.
	if holds := w.transport.Holds(resourceOf(t, "res-1")) + w.transport.Holds(resourceOf(t, "res-2")); holds != 0 {
		t.Fatalf("the scopes are held %d times after every watcher ended", holds)
	}

	// Closed, it gives a watcher of any query nothing, refuses a read of any as closed, and asks the knowledge base nothing.
	m := w.mark()
	for _, each := range everything(t, w.client) {
		watch(t, each.query).ended(t)
		if err := each.read(context.Background()); err == nil || codeOf(err) != string(semiont.BusRequestErrorCodeClosed) {
			t.Fatalf("the read of the %s ended with %v, want bus.closed", each.name, err)
		}
	}
	w.asksCome(t, m, map[string]int{})
}
