// Code generated from specs/src/bus/registry.json — DO NOT EDIT.
//
// Regenerate: node scripts/bus/generate-go.mjs
// The TypeScript side (packages/core/src/bus-protocol.ts) generates from the
// same registry, so the two languages cannot drift apart by hand.

package bus

// Channel is a bus channel name. Only channels the backend will accept on
// /bus/emit have an entry in ChannelSchemas; emitting anything else is a
// client bug the server rejects.
type Channel string

const (
	// payload: StoredEvent(yield:created) — not emittable
	YieldCreated Channel = "yield:created"

	// payload: StoredEvent(yield:cloned) — not emittable
	YieldCloned Channel = "yield:cloned"

	// payload: StoredEvent(yield:updated) — not emittable
	YieldUpdated Channel = "yield:updated"

	// payload: StoredEvent(yield:moved) — not emittable
	YieldMoved Channel = "yield:moved"

	// payload: StoredEvent(yield:representation-added) — not emittable
	YieldRepresentationAdded Channel = "yield:representation-added"

	// payload: StoredEvent(yield:representation-removed) — not emittable
	YieldRepresentationRemoved Channel = "yield:representation-removed"

	// payload: YieldCreateCommand
	YieldCreate Channel = "yield:create"

	// payload: YieldUpdateCommand
	YieldUpdate Channel = "yield:update"

	// payload: YieldMvCommand
	YieldMv Channel = "yield:mv"

	// no payload — not emittable
	YieldClone Channel = "yield:clone"

	// payload: YieldCloneTokenRequest
	YieldCloneTokenRequested Channel = "yield:clone-token-requested"

	// payload: YieldCloneResourceRequest
	YieldCloneResourceRequested Channel = "yield:clone-resource-requested"

	// payload: YieldCloneCreateCommand
	YieldCloneCreate Channel = "yield:clone-create"

	// payload: YieldCreateOk
	YieldCreateOk Channel = "yield:create-ok"

	// payload: CommandError
	YieldCreateFailed Channel = "yield:create-failed"

	// payload: YieldUpdateOk
	YieldUpdateOk Channel = "yield:update-ok"

	// not emittable (no registered schema)
	YieldUpdateFailed Channel = "yield:update-failed"

	// not emittable (no registered schema)
	YieldMoveFailed Channel = "yield:move-failed"

	// not emittable (no registered schema)
	YieldCloneTokenGenerated Channel = "yield:clone-token-generated"

	// not emittable (no registered schema)
	YieldCloneTokenFailed Channel = "yield:clone-token-failed"

	// not emittable (no registered schema)
	YieldCloneResourceResult Channel = "yield:clone-resource-result"

	// not emittable (no registered schema)
	YieldCloneResourceFailed Channel = "yield:clone-resource-failed"

	// payload: YieldCloneCreated
	YieldCloneCreated Channel = "yield:clone-created"

	// not emittable (no registered schema)
	YieldCloneCreateFailed Channel = "yield:clone-create-failed"

	// payload: StoredEvent(mark:added) — not emittable
	MarkAdded Channel = "mark:added"

	// payload: StoredEvent(mark:removed) — not emittable
	MarkRemoved Channel = "mark:removed"

	// payload: StoredEvent(mark:body-updated) — not emittable
	MarkBodyUpdated Channel = "mark:body-updated"

	// payload: StoredEvent(mark:entity-tag-added) — not emittable
	MarkEntityTagAdded Channel = "mark:entity-tag-added"

	// payload: StoredEvent(mark:entity-tag-removed) — not emittable
	MarkEntityTagRemoved Channel = "mark:entity-tag-removed"

	// payload: StoredEvent(mark:archived) — not emittable
	MarkArchived Channel = "mark:archived"

	// payload: StoredEvent(mark:unarchived) — not emittable
	MarkUnarchived Channel = "mark:unarchived"

	// payload: MarkCreateRequest
	MarkCreateRequest Channel = "mark:create-request"

	// payload: MarkCreateCommand
	MarkCreate Channel = "mark:create"

	// payload: MarkDeleteCommand
	MarkDelete Channel = "mark:delete"

	// payload: MarkUpdateBodyCommand
	MarkUpdateBody Channel = "mark:update-body"

	// payload: MarkArchiveCommand
	MarkArchive Channel = "mark:archive"

	// payload: MarkUnarchiveCommand
	MarkUnarchive Channel = "mark:unarchive"

	// payload: MarkUpdateEntityTypesCommand
	MarkUpdateEntityTypes Channel = "mark:update-entity-types"

	// payload: MarkCreateOk
	MarkCreateOk Channel = "mark:create-ok"

	// payload: CommandError
	MarkCreateFailed Channel = "mark:create-failed"

	// payload: MarkDeleteOk
	MarkDeleteOk Channel = "mark:delete-ok"

	// payload: CommandError
	MarkDeleteFailed Channel = "mark:delete-failed"

	// not emittable (no registered schema)
	MarkArchiveOk Channel = "mark:archive-ok"

	// payload: CommandError
	MarkArchiveFailed Channel = "mark:archive-failed"

	// not emittable (no registered schema)
	MarkUnarchiveOk Channel = "mark:unarchive-ok"

	// payload: CommandError
	MarkUnarchiveFailed Channel = "mark:unarchive-failed"

	// not emittable (no registered schema)
	MarkUpdateEntityTypesOk Channel = "mark:update-entity-types-ok"

	// payload: CommandError
	MarkUpdateEntityTypesFailed Channel = "mark:update-entity-types-failed"

	// payload: CommandError
	MarkBodyUpdateFailed Channel = "mark:body-update-failed"

	// payload: SelectionData
	MarkSelectComment Channel = "mark:select-comment"

	// payload: SelectionData
	MarkSelectTag Channel = "mark:select-tag"

	// payload: SelectionData
	MarkSelectAssessment Channel = "mark:select-assessment"

	// payload: SelectionData
	MarkSelectReference Channel = "mark:select-reference"

	// payload: MarkRequestedEvent
	MarkRequested Channel = "mark:requested"

	// no payload — not emittable
	MarkCancelPending Channel = "mark:cancel-pending"

	// payload: MarkSubmitEvent
	MarkSubmit Channel = "mark:submit"

	// payload: MarkAssistRequestEvent
	MarkAssistRequest Channel = "mark:assist-request"

	// no payload — not emittable
	MarkProgressDismiss Channel = "mark:progress-dismiss"

	// not emittable (no registered schema)
	MarkAssistTimeout Channel = "mark:assist-timeout"

	// not emittable (no registered schema)
	MarkCreateError Channel = "mark:create-error"

	// not emittable (no registered schema)
	MarkDeleteError Channel = "mark:delete-error"

	// not emittable (no registered schema)
	BindBodyError Channel = "bind:body-error"

	// payload: StoredEvent(frame:entity-type-added) — not emittable
	FrameEntityTypeAdded Channel = "frame:entity-type-added"

	// payload: StoredEvent(frame:tag-schema-added) — not emittable
	FrameTagSchemaAdded Channel = "frame:tag-schema-added"

	// payload: FrameAddEntityTypeCommand
	FrameAddEntityType Channel = "frame:add-entity-type"

	// payload: FrameAddTagSchemaCommand
	FrameAddTagSchema Channel = "frame:add-tag-schema"

	// not emittable (no registered schema)
	FrameEntityTypeAddOk Channel = "frame:entity-type-add-ok"

	// payload: CommandError
	FrameEntityTypeAddFailed Channel = "frame:entity-type-add-failed"

	// not emittable (no registered schema)
	FrameTagSchemaAddOk Channel = "frame:tag-schema-add-ok"

	// payload: CommandError
	FrameTagSchemaAddFailed Channel = "frame:tag-schema-add-failed"

	// payload: BindInitiateCommand
	BindInitiate Channel = "bind:initiate"

	// payload: BindUpdateBodyCommand
	BindUpdateBody Channel = "bind:update-body"

	// payload: BindBodyUpdated
	BindBodyUpdated Channel = "bind:body-updated"

	// payload: CommandError
	BindBodyUpdateFailed Channel = "bind:body-update-failed"

	// payload: MatchSearchRequest
	MatchSearchRequested Channel = "match:search-requested"

	// payload: MatchSearchResult
	MatchSearchResults Channel = "match:search-results"

	// payload: MatchSearchFailed
	MatchSearchFailed Channel = "match:search-failed"

	// payload: GatherAnnotationRequest
	GatherRequested Channel = "gather:requested"

	// payload: GatherAnnotationComplete
	GatherComplete Channel = "gather:complete"

	// not emittable (no registered schema)
	GatherFailed Channel = "gather:failed"

	// payload: GatherResourceRequest
	GatherResourceRequested Channel = "gather:resource-requested"

	// payload: GatherResourceComplete
	GatherResourceComplete Channel = "gather:resource-complete"

	// not emittable (no registered schema)
	GatherResourceFailed Channel = "gather:resource-failed"

	// payload: GatherSummaryRequest
	GatherSummaryRequested Channel = "gather:summary-requested"

	// not emittable (no registered schema)
	GatherSummaryResult Channel = "gather:summary-result"

	// not emittable (no registered schema)
	GatherSummaryFailed Channel = "gather:summary-failed"

	// payload: GatherProgress
	GatherAnnotationProgress Channel = "gather:annotation-progress"

	// payload: BrowseResourceRequest
	BrowseResourceRequested Channel = "browse:resource-requested"

	// payload: BrowseResourceResult
	BrowseResourceResult Channel = "browse:resource-result"

	// not emittable (no registered schema)
	BrowseResourceFailed Channel = "browse:resource-failed"

	// payload: BrowseAnchoredTextRequest
	BrowseAnchoredTextRequested Channel = "browse:anchored-text-requested"

	// payload: BrowseAnchoredTextResult
	BrowseAnchoredTextResult Channel = "browse:anchored-text-result"

	// not emittable (no registered schema)
	BrowseAnchoredTextFailed Channel = "browse:anchored-text-failed"

	// payload: BrowseResourcesRequest
	BrowseResourcesRequested Channel = "browse:resources-requested"

	// payload: BrowseResourcesResult
	BrowseResourcesResult Channel = "browse:resources-result"

	// not emittable (no registered schema)
	BrowseResourcesFailed Channel = "browse:resources-failed"

	// payload: BrowseAnnotationsRequest
	BrowseAnnotationsRequested Channel = "browse:annotations-requested"

	// payload: BrowseAnnotationsResult
	BrowseAnnotationsResult Channel = "browse:annotations-result"

	// not emittable (no registered schema)
	BrowseAnnotationsFailed Channel = "browse:annotations-failed"

	// payload: BrowseAnnotationRequest
	BrowseAnnotationRequested Channel = "browse:annotation-requested"

	// payload: BrowseAnnotationResult
	BrowseAnnotationResult Channel = "browse:annotation-result"

	// not emittable (no registered schema)
	BrowseAnnotationFailed Channel = "browse:annotation-failed"

	// payload: BrowseEventsRequest
	BrowseEventsRequested Channel = "browse:events-requested"

	// payload: BrowseEventsResult
	BrowseEventsResult Channel = "browse:events-result"

	// not emittable (no registered schema)
	BrowseEventsFailed Channel = "browse:events-failed"

	// payload: BrowseAnnotationHistoryRequest
	BrowseAnnotationHistoryRequested Channel = "browse:annotation-history-requested"

	// payload: BrowseAnnotationHistoryResult
	BrowseAnnotationHistoryResult Channel = "browse:annotation-history-result"

	// not emittable (no registered schema)
	BrowseAnnotationHistoryFailed Channel = "browse:annotation-history-failed"

	// payload: BrowseAnnotationContextRequest
	BrowseAnnotationContextRequested Channel = "browse:annotation-context-requested"

	// not emittable (no registered schema)
	BrowseAnnotationContextResult Channel = "browse:annotation-context-result"

	// not emittable (no registered schema)
	BrowseAnnotationContextFailed Channel = "browse:annotation-context-failed"

	// payload: BrowseReferencedByRequest
	BrowseReferencedByRequested Channel = "browse:referenced-by-requested"

	// payload: BrowseReferencedByResult
	BrowseReferencedByResult Channel = "browse:referenced-by-result"

	// not emittable (no registered schema)
	BrowseReferencedByFailed Channel = "browse:referenced-by-failed"

	// payload: BrowseEntityTypesRequest
	BrowseEntityTypesRequested Channel = "browse:entity-types-requested"

	// payload: BrowseEntityTypesResult
	BrowseEntityTypesResult Channel = "browse:entity-types-result"

	// not emittable (no registered schema)
	BrowseEntityTypesFailed Channel = "browse:entity-types-failed"

	// payload: BrowseTagSchemasRequest
	BrowseTagSchemasRequested Channel = "browse:tag-schemas-requested"

	// payload: BrowseTagSchemasResult
	BrowseTagSchemasResult Channel = "browse:tag-schemas-result"

	// not emittable (no registered schema)
	BrowseTagSchemasFailed Channel = "browse:tag-schemas-failed"

	// payload: BrowseAgentsRequest
	BrowseAgentsRequested Channel = "browse:agents-requested"

	// payload: BrowseAgentsResult
	BrowseAgentsResult Channel = "browse:agents-result"

	// not emittable (no registered schema)
	BrowseAgentsFailed Channel = "browse:agents-failed"

	// payload: BrowseDirectoryRequest
	BrowseDirectoryRequested Channel = "browse:directory-requested"

	// payload: BrowseDirectoryResult
	BrowseDirectoryResult Channel = "browse:directory-result"

	// not emittable (no registered schema)
	BrowseDirectoryFailed Channel = "browse:directory-failed"

	// payload: BrowseResourceOpenEvent
	BrowseResourceOpen Channel = "browse:resource-open"

	// payload: BrowseResourceViewedEvent
	BrowseResourceViewed Channel = "browse:resource-viewed"

	// payload: BrowseEntityTypeClickedEvent
	BrowseEntityTypeClicked Channel = "browse:entity-type-clicked"

	// payload: BrowsePanelToggleEvent
	PanelToggle Channel = "panel:toggle"

	// no payload — not emittable
	PanelClose Channel = "panel:close"

	// no payload — not emittable
	ShellSidebarToggle Channel = "shell:sidebar-toggle"

	// payload: BrowseResourceCloseEvent
	TabsClose Channel = "tabs:close"

	// payload: BrowseResourceReorderEvent
	TabsReorder Channel = "tabs:reorder"

	// payload: BrowseLinkClickedEvent
	NavLinkClicked Channel = "nav:link-clicked"

	// payload: BrowseRouterPushEvent
	NavPush Channel = "nav:push"

	// payload: BeckonHoverEvent
	BeckonHover Channel = "beckon:hover"

	// payload: BeckonFocusEvent
	BeckonFocus Channel = "beckon:focus"

	// payload: BeckonSparkleEvent
	BeckonSparkle Channel = "beckon:sparkle"

	// payload: StoredEvent(job:started) — not emittable
	JobStarted Channel = "job:started"

	// payload: StoredEvent(job:completed) — not emittable
	JobCompleted Channel = "job:completed"

	// payload: StoredEvent(job:failed) — not emittable
	JobFailed Channel = "job:failed"

	// payload: JobStartCommand
	JobStart Channel = "job:start"

	// payload: JobReportProgressCommand
	JobReportProgress Channel = "job:report-progress"

	// payload: JobCompleteCommand
	JobComplete Channel = "job:complete"

	// payload: JobFailCommand
	JobFail Channel = "job:fail"

	// payload: JobQueuedEvent
	JobQueued Channel = "job:queued"

	// payload: JobCancelRequest
	JobCancelRequested Channel = "job:cancel-requested"

	// payload: JobStatusRequest
	JobStatusRequested Channel = "job:status-requested"

	// payload: JobCreateCommand
	JobCreate Channel = "job:create"

	// payload: JobClaimCommand
	JobClaim Channel = "job:claim"

	// payload: JobStatusResult
	JobStatusResult Channel = "job:status-result"

	// not emittable (no registered schema)
	JobStatusFailed Channel = "job:status-failed"

	// payload: JobCreatedResult
	JobCreated Channel = "job:created"

	// not emittable (no registered schema)
	JobCreateFailed Channel = "job:create-failed"

	// not emittable (no registered schema)
	JobClaimed Channel = "job:claimed"

	// not emittable (no registered schema)
	JobClaimFailed Channel = "job:claim-failed"

	// not emittable (no registered schema)
	JobCancelOk Channel = "job:cancel-ok"

	// payload: CommandError
	JobCancelFailed Channel = "job:cancel-failed"

	// not emittable (no registered schema)
	WeaveApplied Channel = "weave:applied"

	// not emittable (no registered schema)
	SmeltSettled Channel = "smelt:settled"

	// payload: WeaveRebuildCommand
	WeaveRebuild Channel = "weave:rebuild"

	// not emittable (no registered schema)
	WeaveRebuildOk Channel = "weave:rebuild-ok"

	// not emittable (no registered schema)
	WeaveRebuildFailed Channel = "weave:rebuild-failed"

	// payload: SmeltRebuildAnchorsCommand
	SmeltRebuildAnchors Channel = "smelt:rebuild-anchors"

	// not emittable (no registered schema)
	SmeltRebuildAnchorsOk Channel = "smelt:rebuild-anchors-ok"

	// not emittable (no registered schema)
	SmeltRebuildAnchorsFailed Channel = "smelt:rebuild-anchors-failed"

	// payload: SettingsThemeChangedEvent
	SettingsThemeChanged Channel = "settings:theme-changed"

	// no payload — not emittable
	SettingsLineNumbersToggled Channel = "settings:line-numbers-toggled"

	// payload: SettingsLocaleChangedEvent
	SettingsLocaleChanged Channel = "settings:locale-changed"

	// payload: SettingsHoverDelayChangedEvent
	SettingsHoverDelayChanged Channel = "settings:hover-delay-changed"

	// not emittable (no registered schema)
	StreamConnected Channel = "stream-connected"

	// not emittable (no registered schema)
	ReplayWindowExceeded Channel = "replay-window-exceeded"

	// not emittable (no registered schema)
	BusResumeGap Channel = "bus:resume-gap"
)

// ChannelSchemas maps an emittable channel to the OpenAPI schema name its
// payload must satisfy — the same mapping the backend validates against.
// A channel absent from this map is not emittable.
var ChannelSchemas = map[Channel]string{
	YieldCreate:                      "YieldCreateCommand",
	YieldUpdate:                      "YieldUpdateCommand",
	YieldMv:                          "YieldMvCommand",
	YieldCloneTokenRequested:         "YieldCloneTokenRequest",
	YieldCloneResourceRequested:      "YieldCloneResourceRequest",
	YieldCloneCreate:                 "YieldCloneCreateCommand",
	YieldCreateOk:                    "YieldCreateOk",
	YieldCreateFailed:                "CommandError",
	YieldUpdateOk:                    "YieldUpdateOk",
	YieldCloneCreated:                "YieldCloneCreated",
	MarkCreateRequest:                "MarkCreateRequest",
	MarkCreate:                       "MarkCreateCommand",
	MarkDelete:                       "MarkDeleteCommand",
	MarkUpdateBody:                   "MarkUpdateBodyCommand",
	MarkArchive:                      "MarkArchiveCommand",
	MarkUnarchive:                    "MarkUnarchiveCommand",
	MarkUpdateEntityTypes:            "MarkUpdateEntityTypesCommand",
	MarkCreateOk:                     "MarkCreateOk",
	MarkCreateFailed:                 "CommandError",
	MarkDeleteOk:                     "MarkDeleteOk",
	MarkDeleteFailed:                 "CommandError",
	MarkArchiveFailed:                "CommandError",
	MarkUnarchiveFailed:              "CommandError",
	MarkUpdateEntityTypesFailed:      "CommandError",
	MarkBodyUpdateFailed:             "CommandError",
	MarkSelectComment:                "SelectionData",
	MarkSelectTag:                    "SelectionData",
	MarkSelectAssessment:             "SelectionData",
	MarkSelectReference:              "SelectionData",
	MarkRequested:                    "MarkRequestedEvent",
	MarkSubmit:                       "MarkSubmitEvent",
	MarkAssistRequest:                "MarkAssistRequestEvent",
	FrameAddEntityType:               "FrameAddEntityTypeCommand",
	FrameAddTagSchema:                "FrameAddTagSchemaCommand",
	FrameEntityTypeAddFailed:         "CommandError",
	FrameTagSchemaAddFailed:          "CommandError",
	BindInitiate:                     "BindInitiateCommand",
	BindUpdateBody:                   "BindUpdateBodyCommand",
	BindBodyUpdated:                  "BindBodyUpdated",
	BindBodyUpdateFailed:             "CommandError",
	MatchSearchRequested:             "MatchSearchRequest",
	MatchSearchResults:               "MatchSearchResult",
	MatchSearchFailed:                "MatchSearchFailed",
	GatherRequested:                  "GatherAnnotationRequest",
	GatherComplete:                   "GatherAnnotationComplete",
	GatherResourceRequested:          "GatherResourceRequest",
	GatherResourceComplete:           "GatherResourceComplete",
	GatherSummaryRequested:           "GatherSummaryRequest",
	GatherAnnotationProgress:         "GatherProgress",
	BrowseResourceRequested:          "BrowseResourceRequest",
	BrowseResourceResult:             "BrowseResourceResult",
	BrowseAnchoredTextRequested:      "BrowseAnchoredTextRequest",
	BrowseAnchoredTextResult:         "BrowseAnchoredTextResult",
	BrowseResourcesRequested:         "BrowseResourcesRequest",
	BrowseResourcesResult:            "BrowseResourcesResult",
	BrowseAnnotationsRequested:       "BrowseAnnotationsRequest",
	BrowseAnnotationsResult:          "BrowseAnnotationsResult",
	BrowseAnnotationRequested:        "BrowseAnnotationRequest",
	BrowseAnnotationResult:           "BrowseAnnotationResult",
	BrowseEventsRequested:            "BrowseEventsRequest",
	BrowseEventsResult:               "BrowseEventsResult",
	BrowseAnnotationHistoryRequested: "BrowseAnnotationHistoryRequest",
	BrowseAnnotationHistoryResult:    "BrowseAnnotationHistoryResult",
	BrowseAnnotationContextRequested: "BrowseAnnotationContextRequest",
	BrowseReferencedByRequested:      "BrowseReferencedByRequest",
	BrowseReferencedByResult:         "BrowseReferencedByResult",
	BrowseEntityTypesRequested:       "BrowseEntityTypesRequest",
	BrowseEntityTypesResult:          "BrowseEntityTypesResult",
	BrowseTagSchemasRequested:        "BrowseTagSchemasRequest",
	BrowseTagSchemasResult:           "BrowseTagSchemasResult",
	BrowseAgentsRequested:            "BrowseAgentsRequest",
	BrowseAgentsResult:               "BrowseAgentsResult",
	BrowseDirectoryRequested:         "BrowseDirectoryRequest",
	BrowseDirectoryResult:            "BrowseDirectoryResult",
	BrowseResourceOpen:               "BrowseResourceOpenEvent",
	BrowseResourceViewed:             "BrowseResourceViewedEvent",
	BrowseEntityTypeClicked:          "BrowseEntityTypeClickedEvent",
	PanelToggle:                      "BrowsePanelToggleEvent",
	TabsClose:                        "BrowseResourceCloseEvent",
	TabsReorder:                      "BrowseResourceReorderEvent",
	NavLinkClicked:                   "BrowseLinkClickedEvent",
	NavPush:                          "BrowseRouterPushEvent",
	BeckonHover:                      "BeckonHoverEvent",
	BeckonFocus:                      "BeckonFocusEvent",
	BeckonSparkle:                    "BeckonSparkleEvent",
	JobStart:                         "JobStartCommand",
	JobReportProgress:                "JobReportProgressCommand",
	JobComplete:                      "JobCompleteCommand",
	JobFail:                          "JobFailCommand",
	JobQueued:                        "JobQueuedEvent",
	JobCancelRequested:               "JobCancelRequest",
	JobStatusRequested:               "JobStatusRequest",
	JobCreate:                        "JobCreateCommand",
	JobClaim:                         "JobClaimCommand",
	JobStatusResult:                  "JobStatusResult",
	JobCreated:                       "JobCreatedResult",
	JobCancelFailed:                  "CommandError",
	WeaveRebuild:                     "WeaveRebuildCommand",
	SmeltRebuildAnchors:              "SmeltRebuildAnchorsCommand",
	SettingsThemeChanged:             "SettingsThemeChangedEvent",
	SettingsLocaleChanged:            "SettingsLocaleChangedEvent",
	SettingsHoverDelayChanged:        "SettingsHoverDelayChangedEvent",
}

// Emittable reports whether the backend accepts this channel on /bus/emit.
func (c Channel) Emittable() bool {
	_, ok := ChannelSchemas[c]
	return ok
}
