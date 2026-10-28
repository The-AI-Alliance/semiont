package semiont

// What keeps a client's queries true: specs/src/client/refresh.json
// (refresh_gen.go), applied to the client's caches. Each event on the bus,
// and the reopening of a dropped stream, asks again for the queries its row
// names, writes the ones whose new value the event carries, and ends the ones
// whose entity is gone. An event acts only on a key its cache holds, and the
// refetches one key is asked for inside a window are one refetch
// (docs/protocol/CACHE-SEMANTICS.md B12 to B13b, B19, B20).

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/The-AI-Alliance/semiont/packages/sdk-go/api"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/bus"
	"github.com/The-AI-Alliance/semiont/packages/sdk-go/internal/required"
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
	if w.disposed {
		w.mu.Unlock()
		return
	}
	if open, ok := w.open[key]; ok {
		open.owed = true
		w.mu.Unlock()
		return
	}
	w.open[key] = &window{refetch: refetch, closing: time.AfterFunc(w.lasting, func() { w.close(key) })}
	w.mu.Unlock()
	refetch()
}

func (w *windows) close(key string) {
	w.mu.Lock()
	open, ok := w.open[key]
	if !ok {
		w.mu.Unlock()
		return
	}
	delete(w.open, key)
	w.mu.Unlock()
	if open.owed {
		w.run(key, open.refetch)
	}
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

// refresher applies the refresh table to a client's caches.
type refresher struct {
	links   *links
	live    *live
	windows *windows
}

var (
	_ cacheEvents = (*refresher)(nil)
	_ cacheActs   = (*refresher)(nil)
)

func newRefresher(l *links, v *live) *refresher {
	return &refresher{links: l, live: v, windows: &windows{lasting: l.timing.InvalidationWindow, open: map[string]*window{}}}
}

// start listens, from now on, until the client closes.
func (r *refresher) start() {
	var channels []bus.Channel
	for trigger := range CacheRefreshTable {
		if trigger != CacheRefreshReopened {
			channels = append(channels, bus.Channel(trigger))
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
				frames, closed := events.drain()
				for _, frame := range frames {
					r.heard(frame)
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
					r.refresh(CacheRefreshReopened, r.reopened())
				}
				opened, left = true, false
			} else {
				left = opened
			}
		}
	})
}

// heard applies the row of frame's trigger. An event that cannot be read is
// something that changed with nothing saying what: everything held is asked
// for again, as after a gap.
func (r *refresher) heard(frame Frame) {
	trigger := CacheRefreshTrigger(frame.Channel)
	subject, err := subjectOf(r, trigger, frame)
	if err != nil {
		for _, query := range CacheQueries {
			applyRefresh(r, CacheRefresh{Reach: CacheRefreshReachHeld, Refetches: []CacheQuery{query}}, cacheSubject{})
		}
		return
	}
	r.refresh(trigger, subject)
}

// refresh applies trigger's row for subject: the one its event's way of
// coming names.
func (r *refresher) refresh(trigger CacheRefreshTrigger, subject cacheSubject) {
	for _, row := range CacheRefreshTable[trigger] {
		if row.When == subject.when {
			applyRefresh(r, row, subject)
			return
		}
	}
}

// dispose stops: what a window owed is dropped, and no window opens after.
// The client's close ends the listening.
func (r *refresher) dispose() { r.windows.dispose() }

// ── What each event names ───────────────────────────────────────────────

// recorded is the resource an event of the record states.
func recorded(frame Frame) (cacheSubject, error) {
	stored, ok := required.ReadAs[api.StoredEventResponse](frame.Payload)
	if !ok {
		return cacheSubject{}, fmt.Errorf("a payload on %s is not that channel's", frame.Channel)
	}
	var subject cacheSubject
	if stored.ResourceId != nil {
		subject.resource = *stored.ResourceId
	}
	return subject, nil
}

// annotationNamed is the annotation an event's own payload names; the zero
// AnnotationId when it names none.
func annotationNamed(payload map[string]any) api.AnnotationId {
	if named, ok := payload["annotationId"].(string); ok {
		if id, err := api.ParseAnnotationId(named); err == nil {
			return id
		}
	}
	return api.AnnotationId{}
}

func (r *refresher) reopened() cacheSubject { return cacheSubject{} }

func (r *refresher) busResumeGap(frame Frame) (cacheSubject, error) {
	gap, ok := required.ReadAs[api.BusResumeGap](frame.Payload)
	if !ok {
		return cacheSubject{}, fmt.Errorf("a payload on %s is not that channel's", frame.Channel)
	}
	return cacheSubject{resource: gap.Scope}, nil
}

func (r *refresher) markAdded(frame Frame) (cacheSubject, error) { return recorded(frame) }

func (r *refresher) markRemoved(frame Frame) (cacheSubject, error) {
	removed, ok := required.ReadAs[api.StoredEventResponse](frame.Payload)
	if !ok {
		return cacheSubject{}, fmt.Errorf("a payload on %s is not that channel's", frame.Channel)
	}
	subject := cacheSubject{annotation: annotationNamed(removed.Payload)}
	if removed.ResourceId != nil {
		subject.resource = *removed.ResourceId
	}
	return subject, nil
}

func (r *refresher) markDeleteOk(frame Frame) (cacheSubject, error) {
	deleted, ok := required.ReadAs[api.MarkDeleteOk](frame.Payload)
	if !ok {
		return cacheSubject{}, fmt.Errorf("a payload on %s is not that channel's", frame.Channel)
	}
	return cacheSubject{annotation: deleted.Response.AnnotationId}, nil
}

func (r *refresher) markBodyUpdated(frame Frame) (cacheSubject, error) {
	updated, ok := required.ReadAs[api.EnrichedResourceEvent](frame.Payload)
	if !ok {
		return cacheSubject{}, fmt.Errorf("a payload on %s is not that channel's", frame.Channel)
	}
	var resource api.ResourceId
	if updated.ResourceId != nil {
		resource = *updated.ResourceId
	}
	if updated.Annotation != nil {
		return cacheSubject{when: CacheRefreshWhenEnriched, resource: resource, annotation: updated.Annotation.Id, written: updated.Annotation}, nil
	}
	return cacheSubject{when: CacheRefreshWhenUnenriched, resource: resource, annotation: annotationNamed(updated.Payload)}, nil
}

func (r *refresher) markEntityTagAdded(frame Frame) (cacheSubject, error)   { return recorded(frame) }
func (r *refresher) markEntityTagRemoved(frame Frame) (cacheSubject, error) { return recorded(frame) }
func (r *refresher) markArchived(frame Frame) (cacheSubject, error)         { return recorded(frame) }
func (r *refresher) markUnarchived(frame Frame) (cacheSubject, error)       { return recorded(frame) }

// What every client hears: its resource is the one it records, not a scope the client holds.
func (r *refresher) yieldCreated(frame Frame) (cacheSubject, error) { return recorded(frame) }
func (r *refresher) yieldUpdated(frame Frame) (cacheSubject, error) { return recorded(frame) }
func (r *refresher) yieldCloned(frame Frame) (cacheSubject, error)  { return recorded(frame) }
func (r *refresher) yieldMoved(frame Frame) (cacheSubject, error)   { return recorded(frame) }

func (r *refresher) frameEntityTypeAdded(frame Frame) (cacheSubject, error) {
	if _, err := recorded(frame); err != nil {
		return cacheSubject{}, err
	}
	return cacheSubject{}, nil
}

func (r *refresher) frameTagSchemaAdded(frame Frame) (cacheSubject, error) {
	if _, err := recorded(frame); err != nil {
		return cacheSubject{}, err
	}
	return cacheSubject{}, nil
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
		again(r, r.live.resource, resource, "resource/"+resource.String())
	}
}

func (r *refresher) refetchAnnotations(reach CacheRefreshReach, subject cacheSubject) {
	for _, resource := range reached(reach, subject, r.live.annotations.Keys()) {
		again(r, r.live.annotations, resource, "annotations/"+resource.String())
	}
}

func (r *refresher) refetchEvents(reach CacheRefreshReach, subject cacheSubject) {
	for _, resource := range reached(reach, subject, r.live.events.Keys()) {
		again(r, r.live.events, resource, "events/"+resource.String())
	}
}

func (r *refresher) refetchReferencedBy(reach CacheRefreshReach, subject cacheSubject) {
	for _, resource := range reached(reach, subject, r.live.referencedBy.Keys()) {
		again(r, r.live.referencedBy, resource, "referenced-by/"+resource.String())
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
		again(r, r.live.annotation, annotation, "annotation/"+annotation.String())
	}
}

// An event does not say which lists it changes, nor which searches would now find its resource.
func (r *refresher) refetchResources(CacheRefreshReach, cacheSubject) {
	r.windows.run("resource-lists", r.live.lists.InvalidateAll)
}

func (r *refresher) refetchMatchedResources(CacheRefreshReach, cacheSubject) {
	r.windows.run("matched-resources", r.live.searches.InvalidateAll)
}

func (r *refresher) refetchEntityTypes(CacheRefreshReach, cacheSubject) {
	again(r, r.live.entityTypes, whole{}, "entity-types")
}

func (r *refresher) refetchTagSchemas(CacheRefreshReach, cacheSubject) {
	again(r, r.live.tagSchemas, whole{}, "tag-schemas")
}

func (r *refresher) refetchAgents(CacheRefreshReach, cacheSubject) {
	if r.live.agents.Known(whole{}) {
		r.windows.run("agents", r.live.invalidateAgents)
	}
}

func (r *refresher) writeAnnotations(subject cacheSubject) { r.live.writeAnnotations(subject) }
func (r *refresher) writeAnnotation(subject cacheSubject)  { r.live.writeAnnotation(subject) }
func (r *refresher) removeAnnotation(subject cacheSubject) { r.live.removeAnnotation(subject) }
