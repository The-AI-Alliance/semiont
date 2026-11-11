package semiont

// What keeps a client's queries true: protocol/specs/src/client/refresh.json
// (refresh_gen.go), applied to the client's caches. Each event on the bus,
// and the reopening of a dropped stream, asks again for the queries its row
// names, writes the ones whose new value the event carries, and ends the ones
// whose entity is gone. An event acts only on a key its cache holds, and the
// refetches one key is asked for inside a window are one refetch
// (protocol/contract/CACHE-SEMANTICS.md B12 to B13b, B19, B20).

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/internal/required"
)

// window is one key's B19 window: what asks again for its key, and whether
// it was asked for again while it was open.
type window struct {
	refetch func()
	closing *time.Timer
	owed    bool
}

// windows is B19: per key, the first refetch an event asks for runs at once
// and opens a window. Any more inside it are owed, and run as one when it
// closes, which opens the next. So a storm of events costs a refetch per key
// per window, and the last event is always reflected.
type windows struct {
	lasting  time.Duration
	mu       sync.Mutex
	open     map[string]*window
	disposed bool
}

// run asks again for key, by refetch: what asks for one key is the same
// whichever event asked.
func (w *windows) run(key string, refetch func()) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.opening(key, refetch)
}

// opening runs refetch for key, or owes it to key's open window. Called with
// mu held, and refetch is run under it: owing never reads a window between
// the event it took and the refetch that event asked for.
func (w *windows) opening(key string, refetch func()) {
	if w.disposed {
		return
	}
	if open, ok := w.open[key]; ok {
		open.owed = true
		return
	}
	w.open[key] = &window{refetch: refetch, closing: time.AfterFunc(w.lasting, func() { w.close(key) })}
	refetch()
}

func (w *windows) close(key string) {
	w.mu.Lock()
	defer w.mu.Unlock()
	open, ok := w.open[key]
	if !ok {
		return
	}
	delete(w.open, key)
	if open.owed {
		w.opening(key, open.refetch)
	}
}

// owing reports whether a window holds a refetch it has not yet run.
func (w *windows) owing() bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, open := range w.open {
		if open.owed {
			return true
		}
	}
	return false
}

// dispose closes every window, and drops what each owed.
func (w *windows) dispose() {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.disposed = true
	for _, open := range w.open {
		open.closing.Stop()
	}
	clear(w.open)
}

// refresher applies the refresh table to a client's caches, and notes the
// place each recorded event it takes reaches.
type refresher struct {
	links   *links
	live    *live
	windows *windows
	// places is the places coupled to what the client keeps
	// (CoupledBookmarks.CoupleTo); nil while none is.
	places atomic.Pointer[CoupledBookmarks]
}

var _ cacheActs = (*refresher)(nil)

func newRefresher(l *links, v *live) *refresher {
	return &refresher{links: l, live: v, windows: &windows{lasting: l.timing.InvalidationWindow, open: map[string]*window{}}}
}

// start listens, from now on, until the client closes: to the table's
// channels, and to every channel a resource's scope carries, whose recorded
// events reach a place.
func (r *refresher) start() {
	channels := make([]bus.Channel, 0, len(CacheRefreshChannels)+len(bus.ResourceScopedChannels))
	for _, trigger := range CacheRefreshChannels {
		channels = append(channels, bus.Channel(trigger))
	}
	for _, scoped := range bus.ResourceScopedChannels {
		if !slices.Contains(channels, scoped) {
			channels = append(channels, scoped)
		}
	}
	// Listening before the work that reads has started: nothing said meanwhile is missed.
	events, leave := r.links.own.listenAmong(channels...)
	r.links.run(func(ctx context.Context) {
		defer leave()
		for {
			select {
			case <-ctx.Done():
				return
			case <-events.ready:
				arrivals, closed := events.drain()
				for _, one := range arrivals {
					r.took(one)
				}
				if closed {
					return
				}
			}
		}
	})
	states := r.links.transport.State().Changes(r.links.life)
	r.links.run(func(context.Context) {
		// B13: the stream is open again having left open, which only a drop
		// does. A changed subscription is handed over with the state still
		// open, and misses nothing.
		opened, left := false, false
		for state := range states {
			if state == ConnectionStateOpen {
				if left {
					r.refresh(CacheRefreshReopened, cacheSubject{})
				}
				opened, left = true, false
			} else {
				left = opened
			}
		}
	})
}

// took takes one arrival: the row of its channel, when the table has one, is
// applied first, so a refetch its event asks for is in flight or owed; only
// then is the place its event reaches noted (B17). A refused frame's arrival
// holds no frame, and so reaches no place.
func (r *refresher) took(one arrival) {
	frame, _ := one.told()
	if _, refreshes := cacheRefreshReadings[CacheRefreshTrigger(frame.Channel)]; refreshes {
		r.heard(one)
	}
	if places := r.places.Load(); places != nil && !one.frame.place.scope.IsZero() {
		places.Save(one.frame.place.scope, one.frame.place.id)
	}
}

// heard applies the row of a frame's channel to what its event names. A frame
// refused, one whose payload is not its channel's, and one a member of which
// its row names is present and is not what it names, is an event that cannot
// be read: the row of an unreadable event applies in its place.
func (r *refresher) heard(one arrival) {
	if one.refusal == nil {
		channel := CacheRefreshTrigger(one.frame.Channel)
		if cacheRefreshReadings[channel](one.frame) {
			if subject, readable := subjectOf(channel, one.frame.Payload); readable {
				r.refresh(channel, subject)
				return
			}
		}
	}
	r.refresh(CacheRefreshUnreadable, cacheSubject{})
}

// refresh applies trigger's row for subject: the one its event's way of
// coming names.
func (r *refresher) refresh(trigger CacheRefreshTrigger, subject cacheSubject) {
	applyRefresh(r, rowOf(trigger, subject.when), subject)
}

// dispose stops: what a window owed is dropped, and no window opens after.
// The client's close ends the listening.
func (r *refresher) dispose() { r.windows.dispose() }

// rowOf is trigger's row for events that come when.
func rowOf(trigger CacheRefreshTrigger, when CacheRefreshWhen) CacheRefresh {
	for _, row := range CacheRefreshTable[trigger] {
		if row.When == when {
			return row
		}
	}
	panic(fmt.Sprintf("the refresh table has no row for %s %q", trigger, when))
}

// ── What each event names ───────────────────────────────────────────────

// readingOf is how frames of c are read: whether a frame's payload is one of
// c's, as c's reader holds it.
func readingOf[P any](bus.Global[P]) func(Frame) bool { return reads[P] }

// scopedReadingOf is readingOf, of a channel a resource's scope carries.
func scopedReadingOf[P, E any](bus.Scoped[P, E]) func(Frame) bool { return reads[P] }

// reads is whether frame's payload is a P.
func reads[P any](frame Frame) bool {
	_, _, faulty := payloadAs[P](frame)
	return !faulty
}

// subjectOf is what an event on channel names, read by the ways of its row
// (protocol/specs/src/client/refresh.json); false when the event is
// unreadable. A split channel's event is enriched when the member its
// enriched row carries is present and not null.
func subjectOf(channel CacheRefreshTrigger, payload json.RawMessage) (cacheSubject, bool) {
	var when CacheRefreshWhen
	for _, row := range CacheRefreshTable[channel] {
		if row.When == CacheRefreshWhenEnriched {
			carried, readable := memberAt(payload, row.Carries)
			if !readable {
				return cacheSubject{}, false
			}
			when = CacheRefreshWhenUnenriched
			if carried != nil {
				when = CacheRefreshWhenEnriched
			}
		}
	}
	row := rowOf(channel, when)
	resource, resourceRead := wayAs[api.ResourceId](payload, row.Names.Resource)
	annotation, annotationRead := wayAs[api.AnnotationId](payload, row.Names.Annotation)
	written, writtenRead := wayAs[*api.Annotation](payload, row.Carries)
	if !resourceRead || !annotationRead || !writtenRead {
		return cacheSubject{}, false
	}
	return cacheSubject{when: when, resource: resource, annotation: annotation, written: written}, true
}

// wayAs is the member way ends at in payload, read as T: T's zero value where
// it names none, and false where the event is unreadable there.
func wayAs[T any](payload json.RawMessage, way CacheRefreshWay) (T, bool) {
	var none T
	member, readable := memberAt(payload, way)
	if !readable || member == nil {
		return none, readable
	}
	return required.ReadAs[T](member)
}

// memberAt is the member way ends at in payload: nil where the row states no
// way, and where the member, or a member it passes through, is absent or
// null. False where a member it passes through is present and is no object.
func memberAt(payload json.RawMessage, way CacheRefreshWay) (json.RawMessage, bool) {
	if len(way) == 0 {
		return nil, true
	}
	member := payload
	for _, name := range way {
		var object map[string]json.RawMessage
		if json.Unmarshal(member, &object) != nil {
			return nil, false
		}
		if member = object[name]; member == nil {
			return nil, true
		}
	}
	if string(member) == "null" {
		return nil, true
	}
	return member, true
}

// ── What each act does to each query ────────────────────────────────────

// again asks again for one key of c, when c holds it (B20), through the key's
// window (B19).
func again[K comparable, V any](r *refresher, c *Cache[K, V], key K, window string) {
	if c.Known(key) {
		r.windows.run(window, func() { c.Invalidate(key) })
	}
}

// reached is the resources a row reaches: every one held, or the one the
// event names.
func reached(reach CacheRefreshReach, subject cacheSubject, held []api.ResourceId) []api.ResourceId {
	if reach == CacheRefreshReachHeld {
		return held
	}
	if subject.resource.IsZero() {
		return nil
	}
	return []api.ResourceId{subject.resource}
}

func (r *refresher) refetchResource(reach CacheRefreshReach, subject cacheSubject) {
	for _, resource := range reached(reach, subject, r.live.resource.Keys()) {
		again(r, r.live.resource, resource, string(CacheQueryResource)+"/"+resource.String())
	}
}

func (r *refresher) refetchAnnotations(reach CacheRefreshReach, subject cacheSubject) {
	for _, resource := range reached(reach, subject, r.live.annotations.Keys()) {
		again(r, r.live.annotations, resource, string(CacheQueryAnnotations)+"/"+resource.String())
	}
}

func (r *refresher) refetchEvents(reach CacheRefreshReach, subject cacheSubject) {
	for _, resource := range reached(reach, subject, r.live.events.Keys()) {
		again(r, r.live.events, resource, string(CacheQueryEvents)+"/"+resource.String())
	}
}

func (r *refresher) refetchReferencedBy(reach CacheRefreshReach, subject cacheSubject) {
	for _, resource := range reached(reach, subject, r.live.referencedBy.Keys()) {
		again(r, r.live.referencedBy, resource, string(CacheQueryReferencedBy)+"/"+resource.String())
	}
}

// refetchAnnotation asks again for the annotation the event names; when it
// names none, for each one held of the resource it names.
func (r *refresher) refetchAnnotation(reach CacheRefreshReach, subject cacheSubject) {
	var annotations []api.AnnotationId
	switch {
	case reach == CacheRefreshReachHeld:
		annotations = r.live.annotation.Keys()
	case !subject.annotation.IsZero():
		annotations = []api.AnnotationId{subject.annotation}
	default:
		annotations = r.live.annotationsOn(subject.resource)
	}
	for _, annotation := range annotations {
		again(r, r.live.annotation, annotation, string(CacheQueryAnnotation)+"/"+annotation.String())
	}
}

// An event does not say which lists it changes, nor which searches would now find its resource.
func (r *refresher) refetchResources(CacheRefreshReach, cacheSubject) {
	r.windows.run(string(CacheQueryResources), r.live.resources.InvalidateAll)
}

func (r *refresher) refetchMatchedResources(CacheRefreshReach, cacheSubject) {
	r.windows.run(string(CacheQueryMatchedResources), r.live.matchedResources.InvalidateAll)
}

func (r *refresher) refetchEntityTypes(CacheRefreshReach, cacheSubject) {
	again(r, r.live.entityTypes, whole{}, string(CacheQueryEntityTypes))
}

func (r *refresher) refetchTagSchemas(CacheRefreshReach, cacheSubject) {
	again(r, r.live.tagSchemas, whole{}, string(CacheQueryTagSchemas))
}

func (r *refresher) refetchEngines(CacheRefreshReach, cacheSubject) {
	if r.live.engines.Known(whole{}) {
		r.windows.run(string(CacheQueryEngines), r.live.invalidateEngines)
	}
}

func (r *refresher) writeAnnotations(subject cacheSubject) { r.live.writeAnnotations(subject) }
func (r *refresher) writeAnnotation(subject cacheSubject)  { r.live.writeAnnotation(subject) }
func (r *refresher) removeAnnotation(subject cacheSubject) { r.live.removeAnnotation(subject) }
