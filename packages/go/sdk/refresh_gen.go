// Code generated from specs/src/client/refresh.json — DO NOT EDIT.
//
// Regenerate: node scripts/spec/generate-cache-refresh-go.mjs

package semiont

import "fmt"

// CacheQuery is a live query a client's cache answers.
type CacheQuery string

// The live queries a client's cache answers.
const (
	// A resource's description.
	CacheQueryResource CacheQuery = "resource"

	// The annotations of a resource.
	CacheQueryAnnotations CacheQuery = "annotations"

	// One annotation.
	CacheQueryAnnotation CacheQuery = "annotation"

	// The recorded history of a resource.
	CacheQueryEvents CacheQuery = "events"

	// The annotations elsewhere that refer to a resource.
	CacheQueryReferencedBy CacheQuery = "referencedBy"

	// A list of resources, one per set of filters asked for. It is a query's
	// answer, kept fresh by what every client hears and by the events of the
	// resources whose scope the client holds, and by nothing else: a resource
	// archived, unarchived or retagged elsewhere, by someone else, does not
	// refresh it.
	CacheQueryResources CacheQuery = "resources"

	// The resources a text search found, one per search and set of filters asked
	// for. A query's answer like `resources`, and kept fresh by the same events
	// and no others.
	CacheQueryMatchedResources CacheQuery = "matchedResources"

	// The knowledge base's entity types.
	CacheQueryEntityTypes CacheQuery = "entityTypes"

	// The knowledge base's tag schemas.
	CacheQueryTagSchemas CacheQuery = "tagSchemas"

	// The roster, joined with the limits each inference key holder reports:
	// asking again asks every `<flow>:limits-requested` operation of the
	// registry again too.
	CacheQueryAgents CacheQuery = "agents"
)

// CacheQueries is every live query, in the table's order.
var CacheQueries = []CacheQuery{CacheQueryResource, CacheQueryAnnotations, CacheQueryAnnotation, CacheQueryEvents, CacheQueryReferencedBy, CacheQueryResources, CacheQueryMatchedResources, CacheQueryEntityTypes, CacheQueryTagSchemas, CacheQueryAgents}

// CacheRefreshTrigger is what refreshes a client's cache: a channel of the
// bus, or the stream open again after a drop.
type CacheRefreshTrigger string

// The triggers of the table.
const (
	CacheRefreshReopened             CacheRefreshTrigger = "reopened"
	CacheRefreshBusResumeGap         CacheRefreshTrigger = "bus:resume-gap"
	CacheRefreshMarkAdded            CacheRefreshTrigger = "mark:added"
	CacheRefreshMarkRemoved          CacheRefreshTrigger = "mark:removed"
	CacheRefreshMarkDeleteOk         CacheRefreshTrigger = "mark:delete-ok"
	CacheRefreshMarkBodyUpdated      CacheRefreshTrigger = "mark:body-updated"
	CacheRefreshMarkEntityTagAdded   CacheRefreshTrigger = "mark:entity-tag-added"
	CacheRefreshMarkEntityTagRemoved CacheRefreshTrigger = "mark:entity-tag-removed"
	CacheRefreshMarkArchived         CacheRefreshTrigger = "mark:archived"
	CacheRefreshMarkUnarchived       CacheRefreshTrigger = "mark:unarchived"
	CacheRefreshYieldCreated         CacheRefreshTrigger = "yield:created"
	CacheRefreshYieldUpdated         CacheRefreshTrigger = "yield:updated"
	CacheRefreshYieldCloned          CacheRefreshTrigger = "yield:cloned"
	CacheRefreshYieldMoved           CacheRefreshTrigger = "yield:moved"
	CacheRefreshFrameEntityTypeAdded CacheRefreshTrigger = "frame:entity-type-added"
	CacheRefreshFrameTagSchemaAdded  CacheRefreshTrigger = "frame:tag-schema-added"
)

// CacheRefreshReach is which keys a row acts on: those the event names
// (subject), or every key the client holds (held).
type CacheRefreshReach string

// The reaches of a row.
const (
	CacheRefreshReachSubject CacheRefreshReach = "subject"
	CacheRefreshReachHeld    CacheRefreshReach = "held"
)

// CacheRefreshWhen splits a channel whose events come two ways: enriched
// with the annotation's new value, or unenriched without. A row of a channel
// whose events come one way states none ("").
type CacheRefreshWhen string

// The two ways a split channel's events come.
const (
	CacheRefreshWhenEnriched   CacheRefreshWhen = "enriched"
	CacheRefreshWhenUnenriched CacheRefreshWhen = "unenriched"
)

// CacheRefresh is one row of the table: the queries a trigger asks again
// for, keeping the value shown meanwhile; those whose new value its event
// carries; and those whose entity its event says is gone.
type CacheRefresh struct {
	When      CacheRefreshWhen
	Reach     CacheRefreshReach
	Refetches []CacheQuery
	Writes    []CacheQuery
	Removes   []CacheQuery
}

// CacheRefreshTable is each trigger's rows.
var CacheRefreshTable = map[CacheRefreshTrigger][]CacheRefresh{
	// The stream is open again after a drop. Events every client hears carry no
	// position, so the ones published meanwhile are lost and nothing replays
	// them: the client asks again for everything they feed. What a resource's
	// own scope feeds needs nothing here: its events are replayed from where the
	// client left off, or `bus:resume-gap` says they could not be.
	CacheRefreshReopened: {
		{Reach: CacheRefreshReachHeld, Refetches: []CacheQuery{CacheQueryResources, CacheQueryMatchedResources, CacheQueryResource, CacheQueryEntityTypes, CacheQueryTagSchemas, CacheQueryAgents}},
	},

	// The gateway could not replay what a scope missed: everything held of that
	// resource, and of its annotations, is asked for again.
	CacheRefreshBusResumeGap: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryAnnotation, CacheQueryResource, CacheQueryEvents, CacheQueryReferencedBy}},
	},

	// An annotation was added to the resource.
	CacheRefreshMarkAdded: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryEvents}},
	},

	// An annotation was removed from the resource.
	CacheRefreshMarkRemoved: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryEvents}, Removes: []CacheQuery{CacheQueryAnnotation}},
	},

	// The reply to this client's own deletion: the annotation is gone whether or
	// not the client holds the scope that would tell it so.
	CacheRefreshMarkDeleteOk: {
		{Reach: CacheRefreshReachSubject, Removes: []CacheQuery{CacheQueryAnnotation}},
	},

	// enriched: An annotation's body changed, and the event carries the
	// annotation as it now is. unenriched: An annotation's body changed, and the
	// event could not say what it now is.
	CacheRefreshMarkBodyUpdated: {
		{When: CacheRefreshWhenEnriched, Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryEvents}, Writes: []CacheQuery{CacheQueryAnnotations, CacheQueryAnnotation}},
		{When: CacheRefreshWhenUnenriched, Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryAnnotation, CacheQueryEvents}},
	},

	// An entity tag was added to the resource.
	CacheRefreshMarkEntityTagAdded: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryResource, CacheQueryEvents}},
	},

	// An entity tag was removed from the resource.
	CacheRefreshMarkEntityTagRemoved: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryResource, CacheQueryEvents}},
	},

	// The resource was archived, which its description states and lists filter
	// on.
	CacheRefreshMarkArchived: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// The resource was unarchived.
	CacheRefreshMarkUnarchived: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was created.
	CacheRefreshYieldCreated: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was updated.
	CacheRefreshYieldUpdated: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was created as a clone.
	CacheRefreshYieldCloned: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was renamed or moved.
	CacheRefreshYieldMoved: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// An entity type was added to the knowledge base.
	CacheRefreshFrameEntityTypeAdded: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryEntityTypes}},
	},

	// A tag schema was added to the knowledge base.
	CacheRefreshFrameTagSchemaAdded: {
		{Reach: CacheRefreshReachSubject, Refetches: []CacheQuery{CacheQueryTagSchemas}},
	},
}

// cacheEvents is what the client's refresher states each trigger's event
// names. A trigger the table gains is a method it lacks.
type cacheEvents interface {
	reopened() cacheSubject
	busResumeGap(frame Frame) (cacheSubject, error)
	markAdded(frame Frame) (cacheSubject, error)
	markRemoved(frame Frame) (cacheSubject, error)
	markDeleteOk(frame Frame) (cacheSubject, error)
	markBodyUpdated(frame Frame) (cacheSubject, error)
	markEntityTagAdded(frame Frame) (cacheSubject, error)
	markEntityTagRemoved(frame Frame) (cacheSubject, error)
	markArchived(frame Frame) (cacheSubject, error)
	markUnarchived(frame Frame) (cacheSubject, error)
	yieldCreated(frame Frame) (cacheSubject, error)
	yieldUpdated(frame Frame) (cacheSubject, error)
	yieldCloned(frame Frame) (cacheSubject, error)
	yieldMoved(frame Frame) (cacheSubject, error)
	frameEntityTypeAdded(frame Frame) (cacheSubject, error)
	frameTagSchemaAdded(frame Frame) (cacheSubject, error)
}

// subjectOf is what frame's event names, by its trigger. A payload that is not
// its channel's is the error.
func subjectOf(events cacheEvents, trigger CacheRefreshTrigger, frame Frame) (cacheSubject, error) {
	switch trigger {
	case CacheRefreshReopened:
		return events.reopened(), nil
	case CacheRefreshBusResumeGap:
		return events.busResumeGap(frame)
	case CacheRefreshMarkAdded:
		return events.markAdded(frame)
	case CacheRefreshMarkRemoved:
		return events.markRemoved(frame)
	case CacheRefreshMarkDeleteOk:
		return events.markDeleteOk(frame)
	case CacheRefreshMarkBodyUpdated:
		return events.markBodyUpdated(frame)
	case CacheRefreshMarkEntityTagAdded:
		return events.markEntityTagAdded(frame)
	case CacheRefreshMarkEntityTagRemoved:
		return events.markEntityTagRemoved(frame)
	case CacheRefreshMarkArchived:
		return events.markArchived(frame)
	case CacheRefreshMarkUnarchived:
		return events.markUnarchived(frame)
	case CacheRefreshYieldCreated:
		return events.yieldCreated(frame)
	case CacheRefreshYieldUpdated:
		return events.yieldUpdated(frame)
	case CacheRefreshYieldCloned:
		return events.yieldCloned(frame)
	case CacheRefreshYieldMoved:
		return events.yieldMoved(frame)
	case CacheRefreshFrameEntityTypeAdded:
		return events.frameEntityTypeAdded(frame)
	case CacheRefreshFrameTagSchemaAdded:
		return events.frameTagSchemaAdded(frame)
	}
	return cacheSubject{}, fmt.Errorf("%s is no trigger of the refresh table", trigger)
}

// cacheActs is what the client's refresher does to each live query a row acts
// on. A query a row comes to act on is a method it lacks.
type cacheActs interface {
	refetchResource(reach CacheRefreshReach, subject cacheSubject)
	refetchAnnotations(reach CacheRefreshReach, subject cacheSubject)
	refetchAnnotation(reach CacheRefreshReach, subject cacheSubject)
	refetchEvents(reach CacheRefreshReach, subject cacheSubject)
	refetchReferencedBy(reach CacheRefreshReach, subject cacheSubject)
	refetchResources(reach CacheRefreshReach, subject cacheSubject)
	refetchMatchedResources(reach CacheRefreshReach, subject cacheSubject)
	refetchEntityTypes(reach CacheRefreshReach, subject cacheSubject)
	refetchTagSchemas(reach CacheRefreshReach, subject cacheSubject)
	refetchAgents(reach CacheRefreshReach, subject cacheSubject)
	writeAnnotations(subject cacheSubject)
	writeAnnotation(subject cacheSubject)
	removeAnnotation(subject cacheSubject)
}

// applyRefresh applies row to what subject names, by acts: its writes, its
// removes, then its refetches.
func applyRefresh(acts cacheActs, row CacheRefresh, subject cacheSubject) {
	for _, query := range row.Writes {
		switch query {
		case CacheQueryAnnotations:
			acts.writeAnnotations(subject)
		case CacheQueryAnnotation:
			acts.writeAnnotation(subject)
		}
	}
	for _, query := range row.Removes {
		switch query {
		case CacheQueryAnnotation:
			acts.removeAnnotation(subject)
		}
	}
	for _, query := range row.Refetches {
		switch query {
		case CacheQueryResource:
			acts.refetchResource(row.Reach, subject)
		case CacheQueryAnnotations:
			acts.refetchAnnotations(row.Reach, subject)
		case CacheQueryAnnotation:
			acts.refetchAnnotation(row.Reach, subject)
		case CacheQueryEvents:
			acts.refetchEvents(row.Reach, subject)
		case CacheQueryReferencedBy:
			acts.refetchReferencedBy(row.Reach, subject)
		case CacheQueryResources:
			acts.refetchResources(row.Reach, subject)
		case CacheQueryMatchedResources:
			acts.refetchMatchedResources(row.Reach, subject)
		case CacheQueryEntityTypes:
			acts.refetchEntityTypes(row.Reach, subject)
		case CacheQueryTagSchemas:
			acts.refetchTagSchemas(row.Reach, subject)
		case CacheQueryAgents:
			acts.refetchAgents(row.Reach, subject)
		}
	}
}
