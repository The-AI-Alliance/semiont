// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs

package bus

import "github.com/The-AI-Alliance/semiont/packages/sdk-go/api"

// Channel is a bus channel's name: what a channel chosen at run time is
// given as, and what each typed value below is named by.
type Channel string

// Every channel that is no operation's request, typed by the payload it
// carries. An operation's request is the operation (operations_gen.go).
var (
	YieldCreated                  = Recorded[api.StoredEventResponse, api.ResourceCreatedPayload]{"yield:created"}
	YieldCloned                   = Recorded[api.StoredEventResponse, api.ResourceClonedPayload]{"yield:cloned"}
	YieldUpdated                  = Recorded[api.StoredEventResponse, api.ResourceUpdatedPayload]{"yield:updated"}
	YieldMoved                    = Recorded[api.StoredEventResponse, api.ResourceMovedPayload]{"yield:moved"}
	YieldRepresentationAdded      = Scoped[api.StoredEventResponse, api.RepresentationAddedPayload]{"yield:representation-added"}
	YieldRepresentationRemoved    = Scoped[api.StoredEventResponse, api.RepresentationRemovedPayload]{"yield:representation-removed"}
	YieldClone                    = Of[Empty]{"yield:clone"}
	YieldCreateOk                 = Emittable[api.YieldCreateOk]{"yield:create-ok"}
	YieldCreateFailed             = Emittable[api.CommandError]{"yield:create-failed"}
	YieldClonePersistOk           = Emittable[api.YieldClonePersistOk]{"yield:clone-persist-ok"}
	YieldClonePersistFailed       = Of[api.CommandError]{"yield:clone-persist-failed"}
	YieldUpdateOk                 = Emittable[api.YieldUpdateOk]{"yield:update-ok"}
	YieldUpdateFailed             = Of[api.CommandError]{"yield:update-failed"}
	YieldCloneTokenGenerated      = Of[Response[api.CloneResourceWithTokenResponse]]{"yield:clone-token-generated"}
	YieldCloneTokenFailed         = Of[api.CommandError]{"yield:clone-token-failed"}
	YieldCloneResourceResult      = Of[Response[api.GetResourceByTokenResponse]]{"yield:clone-resource-result"}
	YieldCloneResourceFailed      = Of[api.CommandError]{"yield:clone-resource-failed"}
	YieldCloneCreated             = Emittable[api.YieldCloneCreated]{"yield:clone-created"}
	YieldCloneCreateFailed        = Of[api.CommandError]{"yield:clone-create-failed"}
	MarkAdded                     = Scoped[api.EnrichedResourceEvent, api.AnnotationAddedPayload]{"mark:added"}
	MarkRemoved                   = Scoped[api.StoredEventResponse, api.AnnotationRemovedPayload]{"mark:removed"}
	MarkBodyUpdated               = Scoped[api.EnrichedResourceEvent, api.AnnotationBodyUpdatedPayload]{"mark:body-updated"}
	MarkEntityTagAdded            = Scoped[api.StoredEventResponse, api.EntityTagChangedPayload]{"mark:entity-tag-added"}
	MarkEntityTagRemoved          = Scoped[api.StoredEventResponse, api.EntityTagChangedPayload]{"mark:entity-tag-removed"}
	MarkArchived                  = Scoped[api.StoredEventResponse, api.ResourceArchivedPayload]{"mark:archived"}
	MarkUnarchived                = Scoped[api.StoredEventResponse, api.ResourceUnarchivedPayload]{"mark:unarchived"}
	MarkUpdateBody                = Emittable[api.MarkUpdateBodyCommand]{"mark:update-body"}
	MarkCreateOk                  = Emittable[api.MarkCreateOk]{"mark:create-ok"}
	MarkCreateFailed              = Emittable[api.CommandError]{"mark:create-failed"}
	MarkCommitOk                  = Emittable[api.MarkCommitOk]{"mark:commit-ok"}
	MarkCommitFailed              = Emittable[api.CommandError]{"mark:commit-failed"}
	MarkDeleteOk                  = Emittable[api.MarkDeleteOk]{"mark:delete-ok"}
	MarkDeleteFailed              = Emittable[api.CommandError]{"mark:delete-failed"}
	MarkArchiveOk                 = Of[Empty]{"mark:archive-ok"}
	MarkArchiveFailed             = Emittable[api.CommandError]{"mark:archive-failed"}
	MarkUnarchiveOk               = Of[Empty]{"mark:unarchive-ok"}
	MarkUnarchiveFailed           = Emittable[api.CommandError]{"mark:unarchive-failed"}
	MarkUpdateEntityTypesOk       = Of[Empty]{"mark:update-entity-types-ok"}
	MarkUpdateEntityTypesFailed   = Emittable[api.CommandError]{"mark:update-entity-types-failed"}
	MarkBodyUpdateFailed          = Emittable[api.CommandError]{"mark:body-update-failed"}
	MarkRequested                 = Emittable[api.MarkRequestedEvent]{"mark:requested"}
	MarkSubmit                    = Emittable[api.MarkSubmitEvent]{"mark:submit"}
	MarkDelegateTimeout           = Of[api.MarkDelegateTimeoutEvent]{"mark:delegate-timeout"}
	MarkCreateError               = Of[api.ResourceErrorEvent]{"mark:create-error"}
	MarkDeleteError               = Of[api.ResourceErrorEvent]{"mark:delete-error"}
	BindBodyError                 = Of[api.ResourceErrorEvent]{"bind:body-error"}
	FrameEntityTypeAdded          = Recorded[api.StoredEventResponse, api.EntityTypeAddedPayload]{"frame:entity-type-added"}
	FrameTagSchemaAdded           = Recorded[api.StoredEventResponse, api.TagSchemaAddedPayload]{"frame:tag-schema-added"}
	FrameEntityTypeAddOk          = Of[Empty]{"frame:entity-type-add-ok"}
	FrameEntityTypeAddFailed      = Emittable[api.CommandError]{"frame:entity-type-add-failed"}
	FrameTagSchemaAddOk           = Of[Empty]{"frame:tag-schema-add-ok"}
	FrameTagSchemaAddFailed       = Emittable[api.CommandError]{"frame:tag-schema-add-failed"}
	PersonProfiled                = Recorded[api.StoredEventResponse, api.PersonProfiledPayload]{"person:profiled"}
	PersonProfile                 = Emittable[api.PersonProfileCommand]{"person:profile"}
	BindInitiate                  = Emittable[api.BindInitiateCommand]{"bind:initiate"}
	BindBodyUpdated               = Emittable[api.BindBodyUpdated]{"bind:body-updated"}
	BindBodyUpdateFailed          = Emittable[api.CommandError]{"bind:body-update-failed"}
	MatchSearchResults            = Emittable[api.MatchSearchResult]{"match:search-results"}
	MatchSearchFailed             = Emittable[api.MatchSearchFailed]{"match:search-failed"}
	MatchResourcesResult          = Emittable[api.MatchResourcesResult]{"match:resources-result"}
	MatchResourcesFailed          = Of[api.CommandError]{"match:resources-failed"}
	MatchLimitsResult             = Emittable[api.InferenceLimitsResult]{"match:limits-result"}
	MatchLimitsFailed             = Of[api.CommandError]{"match:limits-failed"}
	GatherComplete                = Emittable[api.GatherAnnotationComplete]{"gather:complete"}
	GatherFailed                  = Of[api.GatherFailed]{"gather:failed"}
	GatherResourceComplete        = Emittable[api.GatherResourceComplete]{"gather:resource-complete"}
	GatherResourceFailed          = Of[api.GatherResourceFailed]{"gather:resource-failed"}
	GatherSummaryResult           = Of[Response[api.ContextualSummaryResponse]]{"gather:summary-result"}
	GatherSummaryFailed           = Of[api.CommandError]{"gather:summary-failed"}
	GatherReferencedByResult      = Emittable[api.GatherReferencedByResult]{"gather:referenced-by-result"}
	GatherReferencedByFailed      = Of[api.CommandError]{"gather:referenced-by-failed"}
	GatherLimitsResult            = Emittable[api.InferenceLimitsResult]{"gather:limits-result"}
	GatherLimitsFailed            = Of[api.CommandError]{"gather:limits-failed"}
	BrowseResourceResult          = Emittable[api.BrowseResourceResult]{"browse:resource-result"}
	BrowseResourceFailed          = Of[api.CommandError]{"browse:resource-failed"}
	BrowseResourcesResult         = Emittable[api.BrowseResourcesResult]{"browse:resources-result"}
	BrowseResourcesFailed         = Of[api.CommandError]{"browse:resources-failed"}
	BrowseAnnotationResult        = Emittable[api.BrowseAnnotationResult]{"browse:annotation-result"}
	BrowseAnnotationFailed        = Of[api.CommandError]{"browse:annotation-failed"}
	BrowseEventsResult            = Emittable[api.BrowseEventsResult]{"browse:events-result"}
	BrowseEventsFailed            = Of[api.CommandError]{"browse:events-failed"}
	BrowseAnnotationHistoryResult = Emittable[api.BrowseAnnotationHistoryResult]{"browse:annotation-history-result"}
	BrowseAnnotationHistoryFailed = Of[api.CommandError]{"browse:annotation-history-failed"}
	BrowseEntityTypesResult       = Emittable[api.BrowseEntityTypesResult]{"browse:entity-types-result"}
	BrowseEntityTypesFailed       = Of[api.CommandError]{"browse:entity-types-failed"}
	BrowseTagSchemasResult        = Emittable[api.BrowseTagSchemasResult]{"browse:tag-schemas-result"}
	BrowseTagSchemasFailed        = Of[api.CommandError]{"browse:tag-schemas-failed"}
	BrowseAgentsResult            = Emittable[api.BrowseAgentsResult]{"browse:agents-result"}
	BrowseAgentsFailed            = Of[api.CommandError]{"browse:agents-failed"}
	BrowsePeopleResult            = Emittable[api.BrowsePeopleResult]{"browse:people-result"}
	BrowsePeopleFailed            = Of[api.CommandError]{"browse:people-failed"}
	BrowseKbResult                = Emittable[api.BrowseKbResult]{"browse:kb-result"}
	BrowseKbFailed                = Of[api.CommandError]{"browse:kb-failed"}
	BrowseDirectoryResult         = Emittable[api.BrowseDirectoryResult]{"browse:directory-result"}
	BrowseDirectoryFailed         = Of[api.BrowseDirectoryFailed]{"browse:directory-failed"}
	BrowseClick                   = Emittable[api.BrowseClickEvent]{"browse:click"}
	BrowseResourceOpen            = Emittable[api.BrowseResourceOpenEvent]{"browse:resource-open"}
	BrowseResourceViewed          = Emittable[api.BrowseResourceViewedEvent]{"browse:resource-viewed"}
	BrowseEntityTypeClicked       = Emittable[api.BrowseEntityTypeClickedEvent]{"browse:entity-type-clicked"}
	PanelToggle                   = Emittable[api.BrowsePanelToggleEvent]{"panel:toggle"}
	PanelOpen                     = Of[api.BrowsePanelOpenEvent]{"panel:open"}
	PanelClose                    = Of[Empty]{"panel:close"}
	ShellSidebarToggle            = Of[Empty]{"shell:sidebar-toggle"}
	TabsClose                     = Emittable[api.BrowseResourceCloseEvent]{"tabs:close"}
	TabsReorder                   = Emittable[api.BrowseResourceReorderEvent]{"tabs:reorder"}
	NavLinkClicked                = Emittable[api.BrowseLinkClickedEvent]{"nav:link-clicked"}
	NavPush                       = Emittable[api.BrowseRouterPushEvent]{"nav:push"}
	NavExternal                   = Of[api.BrowseExternalNavigateEvent]{"nav:external"}
	BeckonHover                   = Emittable[api.BeckonHoverEvent]{"beckon:hover"}
	BeckonFocus                   = Emittable[api.BeckonFocusEvent]{"beckon:focus"}
	BeckonSparkle                 = Emittable[api.BeckonSparkleEvent]{"beckon:sparkle"}
	JobStarted                    = Scoped[api.StoredEventResponse, api.JobStartedPayload]{"job:started"}
	JobAssigned                   = Scoped[api.StoredEventResponse, api.JobAssignedPayload]{"job:assigned"}
	JobCompleted                  = Scoped[api.StoredEventResponse, api.JobCompletedPayload]{"job:completed"}
	JobFailed                     = Scoped[api.StoredEventResponse, api.JobFailedPayload]{"job:failed"}
	JobStart                      = Emittable[api.JobStartCommand]{"job:start"}
	JobAssign                     = Emittable[api.JobAssignCommand]{"job:assign"}
	JobReportProgress             = Emittable[api.JobReportProgressCommand]{"job:report-progress"}
	JobComplete                   = Emittable[api.JobCompleteCommand]{"job:complete"}
	JobFail                       = Emittable[api.JobFailCommand]{"job:fail"}
	JobCheckpoint                 = Emittable[api.JobCheckpointCommand]{"job:checkpoint"}
	JobQueued                     = Emittable[api.JobQueuedEvent]{"job:queued"}
	JobCancel                     = Emittable[api.JobCancelCommand]{"job:cancel"}
	JobLimitsResult               = Emittable[api.InferenceLimitsResult]{"job:limits-result"}
	JobLimitsFailed               = Of[api.CommandError]{"job:limits-failed"}
	JobStatusResult               = Emittable[api.JobStatusResult]{"job:status-result"}
	JobStatusFailed               = Of[api.CommandError]{"job:status-failed"}
	JobCreated                    = Emittable[api.JobCreatedResult]{"job:created"}
	JobCreateFailed               = Of[api.CommandError]{"job:create-failed"}
	JobClaimed                    = Of[api.JobClaimedResult]{"job:claimed"}
	JobClaimFailed                = Of[api.CommandError]{"job:claim-failed"}
	JobCancelOk                   = Of[Response[api.JobCancelResult]]{"job:cancel-ok"}
	JobCancelFailed               = Emittable[api.CommandError]{"job:cancel-failed"}
	WeaveApplied                  = Of[api.WeaveApplied]{"weave:applied"}
	SmeltSettled                  = Of[api.SmeltSettled]{"smelt:settled"}
	WeaveRebuildOk                = Of[Empty]{"weave:rebuild-ok"}
	WeaveRebuildFailed            = Of[api.CommandError]{"weave:rebuild-failed"}
	SmeltRebuildAnchorsOk         = Of[Empty]{"smelt:rebuild-anchors-ok"}
	SmeltRebuildAnchorsFailed     = Of[api.CommandError]{"smelt:rebuild-anchors-failed"}
	SettingsThemeChanged          = Emittable[api.SettingsThemeChangedEvent]{"settings:theme-changed"}
	SettingsLineNumbersToggled    = Of[Empty]{"settings:line-numbers-toggled"}
	SettingsLocaleChanged         = Emittable[api.SettingsLocaleChangedEvent]{"settings:locale-changed"}
	SettingsHoverDelayChanged     = Emittable[api.SettingsHoverDelayChangedEvent]{"settings:hover-delay-changed"}
	BusResumeGap                  = Of[api.BusResumeGap]{"bus:resume-gap"}
	SessionJoined                 = Emittable[api.SessionJoinedEvent]{"session:joined"}
	SessionLeft                   = Emittable[api.SessionLeftEvent]{"session:left"}
)

// The field of a relayed frame's payload that carries the trace the frame was
// published under: an object of W3C's `traceparent` and, when it has one,
// `tracestate`. A frame the gateway relays over the stream has no headers of
// its own, so the gateway writes the field on its payload, and a receiver
// takes it off before the payload is delivered and continues the trace from
// it. No payload schema declares it, and no subscriber sees it. An emit
// carries its trace in its request's `traceparent` header, and its payload
// carries no such field.
const TraceField = "_trace"
