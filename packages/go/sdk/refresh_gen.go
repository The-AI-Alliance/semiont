// Code generated from protocol/specs/src/client/refresh.json — DO NOT EDIT.
//
// Regenerate: node packages/codegen/schemas/generate-cache-refresh-go.mjs

package semiont

import "github.com/The-AI-Alliance/semiont/packages/go/sdk/bus"

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

	// The knowledge base's engines, joined with the limits each inference key
	// holder reports: asking again asks every `<flow>:limits-requested`
	// operation of the registry again too.
	CacheQueryEngines CacheQuery = "engines"
)

// CacheQueries is every live query, in the table's order.
var CacheQueries = []CacheQuery{CacheQueryResource, CacheQueryAnnotations, CacheQueryAnnotation, CacheQueryEvents, CacheQueryReferencedBy, CacheQueryResources, CacheQueryMatchedResources, CacheQueryEntityTypes, CacheQueryTagSchemas, CacheQueryEngines}

// CacheRefreshTrigger is what refreshes a client's cache: a channel of the
// bus, the stream open again after a drop, or an event on one of the table's
// channels that cannot be read.
type CacheRefreshTrigger string

// The triggers of the table.
const (
	CacheRefreshReopened             CacheRefreshTrigger = "reopened"
	CacheRefreshUnreadable           CacheRefreshTrigger = "unreadable"
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

// CacheRefreshChannels is each trigger of the table that is a channel of the
// bus, in the table's order.
var CacheRefreshChannels = []CacheRefreshTrigger{CacheRefreshBusResumeGap, CacheRefreshMarkAdded, CacheRefreshMarkRemoved, CacheRefreshMarkDeleteOk, CacheRefreshMarkBodyUpdated, CacheRefreshMarkEntityTagAdded, CacheRefreshMarkEntityTagRemoved, CacheRefreshMarkArchived, CacheRefreshMarkUnarchived, CacheRefreshYieldCreated, CacheRefreshYieldUpdated, CacheRefreshYieldCloned, CacheRefreshYieldMoved, CacheRefreshFrameEntityTypeAdded, CacheRefreshFrameTagSchemaAdded}

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

// CacheRefreshWay is a way to a member of an event: the names of the members
// it is within, and its own. Nil where a row states none.
type CacheRefreshWay []string

// CacheRefreshNames is where in its event a row that reaches its subject
// finds it: the way to the resource it names (a ResourceId), and to the
// annotation (an AnnotationId).
type CacheRefreshNames struct {
	Resource   CacheRefreshWay
	Annotation CacheRefreshWay
}

// CacheRefresh is one row of the table: where its event names what it
// reaches; the way to the value it writes (an Annotation); the queries a
// trigger asks again for, keeping the value shown meanwhile; those whose new
// value its event carries; and those whose entity its event says is gone.
type CacheRefresh struct {
	When      CacheRefreshWhen
	Reach     CacheRefreshReach
	Names     CacheRefreshNames
	Carries   CacheRefreshWay
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
		{Reach: CacheRefreshReachHeld, Refetches: []CacheQuery{CacheQueryResources, CacheQueryMatchedResources, CacheQueryResource, CacheQueryEntityTypes, CacheQueryTagSchemas, CacheQueryEngines}},
	},

	// A frame on a channel of this table that its reading refuses, or one a
	// member of which the row names is present and is not what it names:
	// something changed and nothing says what, so every key held is asked for
	// again, as after a gap.
	CacheRefreshUnreadable: {
		{Reach: CacheRefreshReachHeld, Refetches: []CacheQuery{CacheQueryResource, CacheQueryAnnotations, CacheQueryAnnotation, CacheQueryEvents, CacheQueryReferencedBy, CacheQueryResources, CacheQueryMatchedResources, CacheQueryEntityTypes, CacheQueryTagSchemas, CacheQueryEngines}},
	},

	// The gateway could not replay what a scope missed: everything held of that
	// resource, and of its annotations, is asked for again.
	CacheRefreshBusResumeGap: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"scope"}}, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryAnnotation, CacheQueryResource, CacheQueryEvents, CacheQueryReferencedBy}},
	},

	// An annotation was added to the resource.
	CacheRefreshMarkAdded: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryEvents}},
	},

	// An annotation was removed from the resource.
	CacheRefreshMarkRemoved: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}, Annotation: CacheRefreshWay{"payload", "annotationId"}}, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryEvents}, Removes: []CacheQuery{CacheQueryAnnotation}},
	},

	// The reply to this client's own deletion: the annotation is gone whether or
	// not the client holds the scope that would tell it so.
	CacheRefreshMarkDeleteOk: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Annotation: CacheRefreshWay{"response", "annotationId"}}, Removes: []CacheQuery{CacheQueryAnnotation}},
	},

	// enriched: An annotation's body changed, and the event carries the
	// annotation as it now is. unenriched: An annotation's body changed, and the
	// event could not say what it now is.
	CacheRefreshMarkBodyUpdated: {
		{When: CacheRefreshWhenEnriched, Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}, Annotation: CacheRefreshWay{"annotation", "id"}}, Carries: CacheRefreshWay{"annotation"}, Refetches: []CacheQuery{CacheQueryEvents}, Writes: []CacheQuery{CacheQueryAnnotations, CacheQueryAnnotation}},
		{When: CacheRefreshWhenUnenriched, Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}, Annotation: CacheRefreshWay{"payload", "annotationId"}}, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryAnnotation, CacheQueryEvents}},
	},

	// An entity tag was added to the resource.
	CacheRefreshMarkEntityTagAdded: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryResource, CacheQueryEvents}},
	},

	// An entity tag was removed from the resource.
	CacheRefreshMarkEntityTagRemoved: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryAnnotations, CacheQueryResource, CacheQueryEvents}},
	},

	// The resource was archived, which its description states and lists filter
	// on.
	CacheRefreshMarkArchived: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// The resource was unarchived.
	CacheRefreshMarkUnarchived: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was created.
	CacheRefreshYieldCreated: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was updated.
	CacheRefreshYieldUpdated: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was created as a clone.
	CacheRefreshYieldCloned: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
	},

	// A resource was renamed or moved.
	CacheRefreshYieldMoved: {
		{Reach: CacheRefreshReachSubject, Names: CacheRefreshNames{Resource: CacheRefreshWay{"resourceId"}}, Refetches: []CacheQuery{CacheQueryResource, CacheQueryResources, CacheQueryMatchedResources}},
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

// cacheRefreshReadings is how each channel of the table reads a frame:
// whether its payload is one of the channel's.
var cacheRefreshReadings = map[CacheRefreshTrigger]func(Frame) bool{
	CacheRefreshBusResumeGap:         readingOf(bus.BusResumeGap),
	CacheRefreshMarkAdded:            scopedReadingOf(bus.MarkAdded),
	CacheRefreshMarkRemoved:          scopedReadingOf(bus.MarkRemoved),
	CacheRefreshMarkDeleteOk:         readingOf(bus.MarkDeleteOk),
	CacheRefreshMarkBodyUpdated:      scopedReadingOf(bus.MarkBodyUpdated),
	CacheRefreshMarkEntityTagAdded:   scopedReadingOf(bus.MarkEntityTagAdded),
	CacheRefreshMarkEntityTagRemoved: scopedReadingOf(bus.MarkEntityTagRemoved),
	CacheRefreshMarkArchived:         scopedReadingOf(bus.MarkArchived),
	CacheRefreshMarkUnarchived:       scopedReadingOf(bus.MarkUnarchived),
	CacheRefreshYieldCreated:         readingOf(bus.YieldCreated),
	CacheRefreshYieldUpdated:         readingOf(bus.YieldUpdated),
	CacheRefreshYieldCloned:          readingOf(bus.YieldCloned),
	CacheRefreshYieldMoved:           readingOf(bus.YieldMoved),
	CacheRefreshFrameEntityTypeAdded: readingOf(bus.FrameEntityTypeAdded),
	CacheRefreshFrameTagSchemaAdded:  readingOf(bus.FrameTagSchemaAdded),
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
	refetchEngines(reach CacheRefreshReach, subject cacheSubject)
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
		case CacheQueryEngines:
			acts.refetchEngines(row.Reach, subject)
		}
	}
}
