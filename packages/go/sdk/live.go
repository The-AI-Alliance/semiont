package semiont

// A client's live queries: the caches its browse, gather and match queries
// answer from, what each asks the service, and what an event that writes or
// removes a value does to them.

import (
	"context"
	"fmt"
	"iter"
	"reflect"
	"sync"

	"github.com/The-AI-Alliance/semiont/packages/go/sdk/api"
	"github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"
)

// whole is the key of a query the knowledge base has one of. It is written,
// and read, as wholeKey alone.
type whole struct{}

func (whole) MarshalText() ([]byte, error) { return []byte(wholeKey), nil }

func (*whole) UnmarshalText(text []byte) error {
	if string(text) != wholeKey {
		return fmt.Errorf("%q is not the whole key %q", text, wholeKey)
	}
	return nil
}

// filterKey is which resources a list, or a search, is of: the values of
// ResourceFilters, so two lists of the same filters are one key.
type filterKey struct {
	limit         int
	offset        int
	archived      bool
	hasArchived   bool
	entityType    string
	hasEntityType bool
}

func keyOf(filters ResourceFilters) filterKey {
	key := filterKey{limit: filters.limit(), offset: filters.Offset}
	if filters.Archived != nil {
		key.archived, key.hasArchived = *filters.Archived, true
	}
	if filters.EntityType != nil {
		key.entityType, key.hasEntityType = *filters.EntityType, true
	}
	return key
}

// request is the filters key as a list asks for it.
func (k filterKey) request() (limit, offset int, archived *bool, entityType *string) {
	if k.hasArchived {
		archived = &k.archived
	}
	if k.hasEntityType {
		entityType = &k.entityType
	}
	return k.limit, k.offset, archived, entityType
}

// searchKey is a search for resources by text, among those its filters admit.
type searchKey struct {
	search  string
	filters filterKey
}

// cacheSubject is what an event names: which of a split channel's rows it
// is, the keys a row that reaches its subject acts on, and the value an
// enriched event carries.
type cacheSubject struct {
	when       CacheRefreshWhen
	resource   api.ResourceId
	annotation api.AnnotationId
	written    *api.Annotation
}

// live is a client's caches.
type live struct {
	links *links

	// annotationOf is the resource each annotation that was asked for is of:
	// an annotation is kept by its own id, and a request for it names its
	// resource too.
	annotationMu sync.Mutex
	annotationOf map[api.AnnotationId]api.ResourceId

	// enginesAsked is closed, and replaced, each time the engines are asked
	// for: the key holders are asked for their limits after them.
	askedMu      sync.Mutex
	enginesAsked chan struct{}

	// Each live query's cache, named as the query is, holding the value the
	// refresh table's `value` names (refresh_gen.go).
	resource         *Cache[api.ResourceId, resourceValue]
	resources        *Cache[filterKey, resourcesValue]
	annotations      *Cache[api.ResourceId, annotationsValue]
	annotation       *Cache[api.AnnotationId, annotationValue]
	entityTypes      *Cache[whole, entityTypesValue]
	tagSchemas       *Cache[whole, tagSchemasValue]
	engines          *Cache[whole, enginesValue]
	events           *Cache[api.ResourceId, eventsValue]
	referencedBy     *Cache[api.ResourceId, referencedByValue]
	matchedResources *Cache[searchKey, matchedResourcesValue]

	// limits is what each inference key holder reports, joined with the
	// engines when they are shown.
	limits *Cache[bus.Channel, []api.EngineLimits]
}

// newLive is a client's caches, keeping nothing until they are attached to a
// persistence.
func newLive(l *links, content ContentTransport) *live {
	v := &live{links: l, annotationOf: map[api.AnnotationId]api.ResourceId{}, enginesAsked: make(chan struct{})}
	save := l.timing.SaveDebounce
	v.resource = NewCache(func(ctx context.Context, id api.ResourceId) (api.ResourceDescriptor, error) {
		answer, err := ask(ctx, l, bus.BrowseResourceRequested, api.BrowseResourceRequest{ResourceId: id})
		return answer.Response.Resource, err
	}, l.run, nil, save)
	v.resources = NewCache(func(ctx context.Context, key filterKey) (api.ListResourcesResponse, error) {
		limit, offset, archived, entityType := key.request()
		answer, err := ask(ctx, l, bus.BrowseResourcesRequested, api.BrowseResourcesRequest{Limit: &limit, Offset: &offset, Archived: archived, EntityType: entityType})
		return answer.Response, err
	}, l.run, nil, 0)
	v.annotations = NewCache(func(ctx context.Context, id api.ResourceId) (api.GetAnnotationsResponse, error) {
		return content.GetAnnotations(ctx, id)
	}, l.run, nil, save)
	v.annotation = NewCache(func(ctx context.Context, id api.AnnotationId) (api.Annotation, error) {
		v.annotationMu.Lock()
		resource, named := v.annotationOf[id]
		v.annotationMu.Unlock()
		if !named {
			return api.Annotation{}, fmt.Errorf("annotation %s was asked for with no resource", id)
		}
		answer, err := ask(ctx, l, bus.BrowseAnnotationRequested, api.BrowseAnnotationRequest{ResourceId: resource, AnnotationId: id})
		return answer.Response.Annotation, err
	}, l.run, nil, save)
	v.entityTypes = NewCache(func(ctx context.Context, _ whole) ([]string, error) {
		answer, err := ask(ctx, l, bus.BrowseEntityTypesRequested, api.BrowseEntityTypesRequest{})
		return answer.Response.EntityTypes, err
	}, l.run, nil, save)
	v.tagSchemas = NewCache(func(ctx context.Context, _ whole) ([]api.TagSchema, error) {
		answer, err := ask(ctx, l, bus.BrowseTagSchemasRequested, api.BrowseTagSchemasRequest{})
		return answer.Response.TagSchemas, err
	}, l.run, nil, save)
	v.engines = NewCache(func(ctx context.Context, _ whole) ([]api.EngineEntry, error) {
		answer, err := requestAsking(ctx, l.wire, bus.BrowseEnginesRequested, api.BrowseEnginesRequest{}, l.timing.BusRequestTimeout, v.askedForTheEngines)
		return answer.Response.Engines, err
	}, l.run, nil, 0)
	v.limits = NewCache(func(ctx context.Context, holder bus.Channel) ([]api.EngineLimits, error) {
		return v.limitsOf(ctx, holder), nil
	}, l.run, nil, 0)
	v.events = NewCache(func(ctx context.Context, id api.ResourceId) ([]api.AttributedEvent, error) {
		answer, err := ask(ctx, l, bus.BrowseEventsRequested, api.BrowseEventsRequest{ResourceId: id})
		return answer.Response.Events, err
	}, l.run, nil, 0)
	v.referencedBy = NewCache(func(ctx context.Context, id api.ResourceId) ([]api.GetReferencedByResponseReferencedByItem, error) {
		answer, err := ask(ctx, l, bus.GatherReferencedByRequested, api.GatherReferencedByRequest{ResourceId: id})
		return answer.Response.ReferencedBy, err
	}, l.run, nil, 0)
	v.matchedResources = NewCache(func(ctx context.Context, key searchKey) (api.MatchResourcesResponse, error) {
		limit, offset, archived, entityType := key.filters.request()
		answer, err := ask(ctx, l, bus.MatchResourcesRequested, api.MatchResourcesRequest{Search: key.search, Limit: &limit, Offset: &offset, Archived: archived, EntityType: entityType})
		return answer.Response, err
	}, l.run, nil, 0)
	return v
}

// keepIn attaches cache to a persister of what it holds, under query's key,
// telling persistence's refused each write its storage refuses.
func keepIn[K comparable, V any](cache *Cache[K, V], persistence *CachePersistence, query CacheQuery, timing Timing) {
	cache.attach(NewStoragePersister[K, V](persistence.Storage, CacheKey(persistence.KbID, persistence.PersonKey, query), timing.MaxStoredBytesCount), persistence.refused)
}

// limitsOf is the engines one key holder reports the limits of. A holder
// that is down, silent or mistaken reports none: its engines show no limits,
// and the engines are not held up by it for longer than a request waits.
func (v *live) limitsOf(ctx context.Context, holder bus.Channel) []api.EngineLimits {
	for _, operation := range bus.LimitsOperations {
		if operation.Request().Channel() != holder {
			continue
		}
		answer, err := ask(ctx, v.links, operation, api.InferenceLimitsRequest{})
		if err != nil {
			return nil
		}
		return answer.Response.Limits
	}
	return nil
}

// askedForTheEngines says the engines' request is being sent.
func (v *live) askedForTheEngines() {
	v.askedMu.Lock()
	defer v.askedMu.Unlock()
	close(v.enginesAsked)
	v.enginesAsked = make(chan struct{})
}

// nextEnginesAsk is closed the next time the engines are asked for.
func (v *live) nextEnginesAsk() <-chan struct{} {
	v.askedMu.Lock()
	defer v.askedMu.Unlock()
	return v.enginesAsked
}

// annotationOn notes the resource an annotation is of, for its request.
func (v *live) annotationOn(annotation api.AnnotationId, resource api.ResourceId) {
	v.annotationMu.Lock()
	defer v.annotationMu.Unlock()
	v.annotationOf[annotation] = resource
}

// annotationsOn is each annotation held of resource.
func (v *live) annotationsOn(resource api.ResourceId) []api.AnnotationId {
	v.annotationMu.Lock()
	defer v.annotationMu.Unlock()
	var on []api.AnnotationId
	for annotation, of := range v.annotationOf {
		if of == resource {
			on = append(on, annotation)
		}
	}
	return on
}

// holders is the key of each key holder's report of its models' limits: the
// operation that asks it.
func holders() []bus.Channel {
	keys := make([]bus.Channel, 0, len(bus.LimitsOperations))
	for _, operation := range bus.LimitsOperations {
		keys = append(keys, operation.Request().Channel())
	}
	return keys
}

// invalidateEngines says the engines are out of date, and so is what each
// key holder reported.
func (v *live) invalidateEngines() {
	v.engines.Invalidate(whole{})
	for _, holder := range holders() {
		v.limits.Invalidate(holder)
	}
}

// enginesWithLimits is the engines, asked for first, with each model's
// limits as the services holding its credentials report them.
func (v *live) enginesWithLimits() *Cached[[]EngineWithLimits] {
	return &Cached[[]EngineWithLimits]{
		fresh: func(ctx context.Context) ([]EngineWithLimits, error) {
			asked := v.nextEnginesAsk()
			listed := make(chan outcome[[]api.EngineEntry], 1)
			go func() {
				entries, err := v.engines.Fetch(ctx, whole{})
				listed <- outcome[[]api.EngineEntry]{entries, err}
			}()
			reports := make(chan []api.EngineLimits, len(bus.LimitsOperations))
			startHolders := func() {
				for _, holder := range holders() {
					go func() {
						limits, _ := v.limits.Fetch(ctx, holder)
						reports <- limits
					}()
				}
			}
			// The key holders are asked after the engines are: when their request is sent, or when it has been answered.
			var answered *outcome[[]api.EngineEntry]
			select {
			case <-asked:
				startHolders()
			case got := <-listed:
				answered = &got
				startHolders()
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			if answered == nil {
				select {
				case got := <-listed:
					answered = &got
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			// Engines that could not be had fail the read at once: nothing the holders say can be shown without them.
			if answered.err != nil {
				return nil, answered.err
			}
			var reported []api.EngineLimits
			for range bus.LimitsOperations {
				select {
				case limits := <-reports:
					reported = append(reported, limits...)
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			return joined(answered.value, reported), nil
		},
		watch:      v.engineStates,
		invalidate: v.invalidateEngines,
	}
}

// engineStates is the engines' state, joined with what each key holder has
// reported: a holder that has not answered delays only its own engines'
// limits. A state is given when it differs from the one before.
func (v *live) engineStates(ctx context.Context) iter.Seq[CacheState] {
	return func(yield func(CacheState) bool) {
		ctx, stop := context.WithCancel(ctx)
		defer stop()
		var mu sync.Mutex
		changed := make(chan struct{}, 1)
		tell := func() {
			select {
			case changed <- struct{}{}:
			default:
			}
		}
		var engines CacheState
		keyHolders := holders()
		reported := make([][]api.EngineLimits, len(keyHolders))
		ended := false
		end := func() {
			mu.Lock()
			ended = true
			mu.Unlock()
			tell()
		}
		asked := v.nextEnginesAsk()
		held := make(chan struct{})
		go func() {
			defer end()
			first := true
			for state := range v.engines.Observe(ctx, whole{}) {
				mu.Lock()
				engines = state
				mu.Unlock()
				// Engines already held are asked for no more: their holders need not wait for an ask.
				if _, ready := state.(Ready[[]api.EngineEntry]); ready && first {
					close(held)
					first = false
				}
				tell()
			}
		}()
		go func() {
			// The key holders are watched once the engines have been asked for, or are held already.
			select {
			case <-asked:
			case <-held:
			case <-ctx.Done():
				return
			}
			for i, holder := range keyHolders {
				go func() {
					defer end()
					for state := range v.limits.Observe(ctx, holder) {
						if ready, ok := state.(Ready[[]api.EngineLimits]); ok {
							mu.Lock()
							reported[i] = ready.Value
							mu.Unlock()
							tell()
						}
					}
				}()
			}
		}()
		var last CacheState
		for {
			select {
			case <-changed:
			case <-ctx.Done():
				return
			}
			mu.Lock()
			state, done := engines, ended
			var limits []api.EngineLimits
			for _, report := range reported {
				limits = append(limits, report...)
			}
			mu.Unlock()
			if done {
				return
			}
			if state == nil {
				continue
			}
			now := shown(state, func(entries []api.EngineEntry) []EngineWithLimits { return joined(entries, limits) })
			if reflect.DeepEqual(now, last) {
				continue
			}
			last = now
			if !yield(now) {
				return
			}
		}
	}
}

// writeAnnotations patches the annotation an event carries into its
// resource's list, asking for nothing.
func (v *live) writeAnnotations(subject cacheSubject) {
	if subject.resource.IsZero() || subject.written == nil {
		return
	}
	written := *subject.written
	// A patch: the list's fetch in flight can hold what the event does not (B13b).
	v.annotations.Patch(subject.resource, func(held annotationsValue) annotationsValue {
		// Where the annotation was, or at the list's end.
		listed := make([]api.Annotation, 0, len(held.Annotations)+1)
		replaced := false
		for _, annotation := range held.Annotations {
			if annotation.Id == written.Id {
				listed = append(listed, written)
				replaced = true
				continue
			}
			listed = append(listed, annotation)
		}
		if !replaced {
			listed = append(listed, written)
		}
		held.Annotations = listed
		return held
	})
}

func (v *live) writeAnnotation(subject cacheSubject) {
	if subject.resource.IsZero() || subject.written == nil {
		return
	}
	v.annotationOn(subject.written.Id, subject.resource)
	v.annotation.Set(subject.written.Id, *subject.written)
}

// removeAnnotation ends an annotation the cache holds as not found. What says
// which resource it was of is kept: an observer arriving at the ended key
// asks the service, and that request names the resource.
func (v *live) removeAnnotation(subject cacheSubject) {
	if subject.annotation.IsZero() || !v.annotation.Known(subject.annotation) {
		return
	}
	v.annotation.Remove(subject.annotation, &BusRequestError{Code: BusRequestErrorCodeNotFound, Message: fmt.Sprintf("Annotation %s was removed", subject.annotation)})
}

// liveCache is what the client asks of each of its caches as a whole.
type liveCache interface {
	PersistencePending() bool
	keptFetching() bool
	Close()
}

// caches is every cache of the client's.
func (v *live) caches() []liveCache {
	return []liveCache{v.resource, v.resources, v.annotations, v.annotation, v.entityTypes, v.tagSchemas, v.engines, v.limits, v.events, v.referencedBy, v.matchedResources}
}

// persistenceSettled reports whether every cache the client keeps is at
// rest: none is fetching, and none owes a save. A cache that keeps nothing is
// always at rest.
func (v *live) persistenceSettled() bool {
	for _, cache := range v.caches() {
		if cache.PersistencePending() {
			return false
		}
	}
	return true
}

// keptFetching reports whether a cache the client keeps has a fetch in
// flight.
func (v *live) keptFetching() bool {
	for _, cache := range v.caches() {
		if cache.keptFetching() {
			return true
		}
	}
	return false
}

// dispose ends the queries: every watcher's states end, what was owed to
// storage is saved, and nothing is fetched after.
func (v *live) dispose() {
	for _, cache := range v.caches() {
		cache.Close()
	}
}
