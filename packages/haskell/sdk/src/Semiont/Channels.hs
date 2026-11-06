-- Generated from protocol/specs/src/bus/registry.json. Do not edit.
{-# LANGUAGE DataKinds, GADTs, KindSignatures, OverloadedStrings #-}
module Semiont.Channels (Scope(..), ScopeArg(..), Channel(..), Operation(..), SomeOperation(..), allOperations, channelName, channelNames, globalChannels, scopedChannels, channelSchema, channelIsScoped, encodePayload, decodePayload, operationChannels, persistedEventTypes) where
import Data.Aeson (Value(..), toJSON, parseJSON)
import qualified Data.Aeson.Key as Key
import qualified Data.Aeson.KeyMap as KM
import Data.Aeson.Types (parseEither)
import Data.Text (Text)
import qualified Data.Text as T
import qualified Semiont.Types as Types
data Scope = Global | Scoped
data ScopeArg (scope :: Scope) where
  NoScope :: ScopeArg 'Global
  InScope :: Types.ResourceId -> ScopeArg 'Scoped
data Channel (scope :: Scope) payload where
  YieldCreated :: Channel 'Global Types.StoredEventResponse
  YieldCloned :: Channel 'Global Types.StoredEventResponse
  YieldUpdated :: Channel 'Global Types.StoredEventResponse
  YieldMoved :: Channel 'Global Types.StoredEventResponse
  YieldRepresentationAdded :: Channel 'Scoped Types.StoredEventResponse
  YieldRepresentationRemoved :: Channel 'Scoped Types.StoredEventResponse
  YieldCreate :: Channel 'Global Types.YieldCreateCommand
  YieldClonePersist :: Channel 'Global Types.YieldClonePersistCommand
  YieldUpdate :: Channel 'Global Types.YieldUpdateCommand
  YieldClone :: Channel 'Global Types.EmptyBusPayload
  YieldCloneTokenRequested :: Channel 'Global Types.YieldCloneTokenRequest
  YieldCloneResourceRequested :: Channel 'Global Types.YieldCloneResourceRequest
  YieldCloneCreate :: Channel 'Global Types.YieldCloneCreateCommand
  YieldCreateOk :: Channel 'Global Types.YieldCreateOk
  YieldCreateFailed :: Channel 'Global Types.CommandError
  YieldClonePersistOk :: Channel 'Global Types.YieldClonePersistOk
  YieldClonePersistFailed :: Channel 'Global Types.CommandError
  YieldUpdateOk :: Channel 'Global Types.YieldUpdateOk
  YieldUpdateFailed :: Channel 'Global Types.CommandError
  YieldCloneTokenGenerated :: Channel 'Global Types.CloneResourceWithTokenResponseBusEnvelope
  YieldCloneTokenFailed :: Channel 'Global Types.CommandError
  YieldCloneResourceResult :: Channel 'Global Types.GetResourceByTokenResponseBusEnvelope
  YieldCloneResourceFailed :: Channel 'Global Types.CommandError
  YieldCloneCreated :: Channel 'Global Types.YieldCloneCreated
  YieldCloneCreateFailed :: Channel 'Global Types.CommandError
  MarkAdded :: Channel 'Scoped Types.EnrichedResourceEvent
  MarkRemoved :: Channel 'Scoped Types.StoredEventResponse
  MarkBodyUpdated :: Channel 'Scoped Types.EnrichedResourceEvent
  MarkEntityTagAdded :: Channel 'Scoped Types.StoredEventResponse
  MarkEntityTagRemoved :: Channel 'Scoped Types.StoredEventResponse
  MarkArchived :: Channel 'Scoped Types.StoredEventResponse
  MarkUnarchived :: Channel 'Scoped Types.StoredEventResponse
  MarkCreateRequest :: Channel 'Global Types.MarkCreateRequest
  MarkDelete :: Channel 'Global Types.MarkDeleteCommand
  MarkUpdateBody :: Channel 'Global Types.MarkUpdateBodyCommand
  MarkArchive :: Channel 'Global Types.MarkArchiveCommand
  MarkUnarchive :: Channel 'Global Types.MarkUnarchiveCommand
  MarkUpdateEntityTypes :: Channel 'Global Types.MarkUpdateEntityTypesCommand
  MarkCreateOk :: Channel 'Global Types.MarkCreateOk
  MarkCreateFailed :: Channel 'Global Types.CommandError
  MarkCommit :: Channel 'Global Types.MarkCommitCommand
  MarkCommitOk :: Channel 'Global Types.MarkCommitOk
  MarkCommitFailed :: Channel 'Global Types.CommandError
  MarkDeleteOk :: Channel 'Global Types.MarkDeleteOk
  MarkDeleteFailed :: Channel 'Global Types.CommandError
  MarkArchiveOk :: Channel 'Global Types.EmptyBusPayload
  MarkArchiveFailed :: Channel 'Global Types.CommandError
  MarkUnarchiveOk :: Channel 'Global Types.EmptyBusPayload
  MarkUnarchiveFailed :: Channel 'Global Types.CommandError
  MarkUpdateEntityTypesOk :: Channel 'Global Types.EmptyBusPayload
  MarkUpdateEntityTypesFailed :: Channel 'Global Types.CommandError
  MarkBodyUpdateFailed :: Channel 'Global Types.CommandError
  MarkRequested :: Channel 'Global Types.MarkRequestedEvent
  MarkSubmit :: Channel 'Global Types.MarkSubmitEvent
  MarkDelegateTimeout :: Channel 'Global Types.MarkDelegateTimeoutEvent
  MarkCreateError :: Channel 'Global Types.ResourceErrorEvent
  MarkDeleteError :: Channel 'Global Types.ResourceErrorEvent
  BindBodyError :: Channel 'Global Types.ResourceErrorEvent
  FrameEntityTypeAdded :: Channel 'Global Types.StoredEventResponse
  FrameTagSchemaAdded :: Channel 'Global Types.StoredEventResponse
  FrameAddEntityType :: Channel 'Global Types.FrameAddEntityTypeCommand
  FrameAddTagSchema :: Channel 'Global Types.FrameAddTagSchemaCommand
  FrameEntityTypeAddOk :: Channel 'Global Types.EmptyBusPayload
  FrameEntityTypeAddFailed :: Channel 'Global Types.CommandError
  FrameTagSchemaAddOk :: Channel 'Global Types.EmptyBusPayload
  FrameTagSchemaAddFailed :: Channel 'Global Types.CommandError
  PrincipalProfiled :: Channel 'Global Types.StoredEventResponse
  PrincipalProfile :: Channel 'Global Types.PrincipalProfileCommand
  BindInitiate :: Channel 'Global Types.BindInitiateCommand
  BindUpdateBody :: Channel 'Global Types.BindUpdateBodyCommand
  BindBodyUpdated :: Channel 'Global Types.BindBodyUpdated
  BindBodyUpdateFailed :: Channel 'Global Types.CommandError
  MatchSearchRequested :: Channel 'Global Types.MatchSearchRequest
  MatchSearchResults :: Channel 'Global Types.MatchSearchResult
  MatchSearchFailed :: Channel 'Global Types.MatchSearchFailed
  MatchResourcesRequested :: Channel 'Global Types.MatchResourcesRequest
  MatchResourcesResult :: Channel 'Global Types.MatchResourcesResult
  MatchResourcesFailed :: Channel 'Global Types.CommandError
  MatchLimitsRequested :: Channel 'Global Types.InferenceLimitsRequest
  MatchLimitsResult :: Channel 'Global Types.InferenceLimitsResult
  MatchLimitsFailed :: Channel 'Global Types.CommandError
  GatherRequested :: Channel 'Global Types.GatherAnnotationRequest
  GatherComplete :: Channel 'Global Types.GatherAnnotationComplete
  GatherFailed :: Channel 'Global Types.GatherFailed
  GatherResourceRequested :: Channel 'Global Types.GatherResourceRequest
  GatherResourceComplete :: Channel 'Global Types.GatherResourceComplete
  GatherResourceFailed :: Channel 'Global Types.GatherResourceFailed
  GatherSummaryRequested :: Channel 'Global Types.GatherSummaryRequest
  GatherSummaryResult :: Channel 'Global Types.ContextualSummaryResponseBusEnvelope
  GatherSummaryFailed :: Channel 'Global Types.CommandError
  GatherReferencedByRequested :: Channel 'Global Types.GatherReferencedByRequest
  GatherReferencedByResult :: Channel 'Global Types.GatherReferencedByResult
  GatherReferencedByFailed :: Channel 'Global Types.CommandError
  GatherLimitsRequested :: Channel 'Global Types.InferenceLimitsRequest
  GatherLimitsResult :: Channel 'Global Types.InferenceLimitsResult
  GatherLimitsFailed :: Channel 'Global Types.CommandError
  BrowseResourceRequested :: Channel 'Global Types.BrowseResourceRequest
  BrowseResourceResult :: Channel 'Global Types.BrowseResourceResult
  BrowseResourceFailed :: Channel 'Global Types.CommandError
  BrowseResourcesRequested :: Channel 'Global Types.BrowseResourcesRequest
  BrowseResourcesResult :: Channel 'Global Types.BrowseResourcesResult
  BrowseResourcesFailed :: Channel 'Global Types.CommandError
  BrowseAnnotationRequested :: Channel 'Global Types.BrowseAnnotationRequest
  BrowseAnnotationResult :: Channel 'Global Types.BrowseAnnotationResult
  BrowseAnnotationFailed :: Channel 'Global Types.CommandError
  BrowseEventsRequested :: Channel 'Global Types.BrowseEventsRequest
  BrowseEventsResult :: Channel 'Global Types.BrowseEventsResult
  BrowseEventsFailed :: Channel 'Global Types.CommandError
  BrowseAnnotationHistoryRequested :: Channel 'Global Types.BrowseAnnotationHistoryRequest
  BrowseAnnotationHistoryResult :: Channel 'Global Types.BrowseAnnotationHistoryResult
  BrowseAnnotationHistoryFailed :: Channel 'Global Types.CommandError
  BrowseEntityTypesRequested :: Channel 'Global Types.BrowseEntityTypesRequest
  BrowseEntityTypesResult :: Channel 'Global Types.BrowseEntityTypesResult
  BrowseEntityTypesFailed :: Channel 'Global Types.CommandError
  BrowseTagSchemasRequested :: Channel 'Global Types.BrowseTagSchemasRequest
  BrowseTagSchemasResult :: Channel 'Global Types.BrowseTagSchemasResult
  BrowseTagSchemasFailed :: Channel 'Global Types.CommandError
  BrowseEnginesRequested :: Channel 'Global Types.BrowseEnginesRequest
  BrowseEnginesResult :: Channel 'Global Types.BrowseEnginesResult
  BrowseEnginesFailed :: Channel 'Global Types.CommandError
  BrowseProfilesRequested :: Channel 'Global Types.BrowseProfilesRequest
  BrowseProfilesResult :: Channel 'Global Types.BrowseProfilesResult
  BrowseProfilesFailed :: Channel 'Global Types.CommandError
  BrowseKbRequested :: Channel 'Global Types.BrowseKbRequest
  BrowseKbResult :: Channel 'Global Types.BrowseKbResult
  BrowseKbFailed :: Channel 'Global Types.CommandError
  BrowseDirectoryRequested :: Channel 'Global Types.BrowseDirectoryRequest
  BrowseDirectoryResult :: Channel 'Global Types.BrowseDirectoryResult
  BrowseDirectoryFailed :: Channel 'Global Types.BrowseDirectoryFailed
  BrowseClick :: Channel 'Global Types.BrowseClickEvent
  BrowseResourceOpen :: Channel 'Global Types.BrowseResourceOpenEvent
  BrowseResourceViewed :: Channel 'Global Types.BrowseResourceViewedEvent
  BrowseEntityTypeClicked :: Channel 'Global Types.BrowseEntityTypeClickedEvent
  PanelToggle :: Channel 'Global Types.BrowsePanelToggleEvent
  PanelOpen :: Channel 'Global Types.BrowsePanelOpenEvent
  PanelClose :: Channel 'Global Types.EmptyBusPayload
  ShellSidebarToggle :: Channel 'Global Types.EmptyBusPayload
  TabsClose :: Channel 'Global Types.BrowseResourceCloseEvent
  TabsReorder :: Channel 'Global Types.BrowseResourceReorderEvent
  NavLinkClicked :: Channel 'Global Types.BrowseLinkClickedEvent
  NavPush :: Channel 'Global Types.BrowseRouterPushEvent
  NavExternal :: Channel 'Global Types.BrowseExternalNavigateEvent
  BeckonHover :: Channel 'Global Types.BeckonHoverEvent
  BeckonFocus :: Channel 'Global Types.BeckonFocusEvent
  BeckonSparkle :: Channel 'Global Types.BeckonSparkleEvent
  JobStarted :: Channel 'Scoped Types.StoredEventResponse
  JobAssigned :: Channel 'Scoped Types.StoredEventResponse
  JobCompleted :: Channel 'Scoped Types.StoredEventResponse
  JobFailed :: Channel 'Scoped Types.StoredEventResponse
  JobStart :: Channel 'Global Types.JobStartCommand
  JobAssign :: Channel 'Global Types.JobAssignCommand
  JobReportProgress :: Channel 'Global Types.JobReportProgressCommand
  JobComplete :: Channel 'Global Types.JobCompleteCommand
  JobFail :: Channel 'Global Types.JobFailCommand
  JobCheckpoint :: Channel 'Global Types.JobCheckpointCommand
  JobQueued :: Channel 'Global Types.JobQueuedEvent
  JobCancelRequested :: Channel 'Global Types.JobCancelRequest
  JobCancel :: Channel 'Global Types.JobCancelCommand
  JobLimitsRequested :: Channel 'Global Types.InferenceLimitsRequest
  JobLimitsResult :: Channel 'Global Types.InferenceLimitsResult
  JobLimitsFailed :: Channel 'Global Types.CommandError
  JobStatusRequested :: Channel 'Global Types.JobStatusRequest
  JobCreate :: Channel 'Global Types.JobCreateCommand
  JobClaim :: Channel 'Global Types.JobClaimCommand
  JobStatusResult :: Channel 'Global Types.JobStatusResult
  JobStatusFailed :: Channel 'Global Types.CommandError
  JobCreated :: Channel 'Global Types.JobCreatedResult
  JobCreateFailed :: Channel 'Global Types.CommandError
  JobClaimed :: Channel 'Global Types.JobClaimedResult
  JobClaimFailed :: Channel 'Global Types.CommandError
  JobCancelOk :: Channel 'Global Types.JobCancelResultBusEnvelope
  JobCancelFailed :: Channel 'Global Types.CommandError
  WeaveApplied :: Channel 'Global Types.WeaveApplied
  SmeltSettled :: Channel 'Global Types.SmeltSettled
  WeaveRebuild :: Channel 'Global Types.WeaveRebuildCommand
  WeaveRebuildOk :: Channel 'Global Types.EmptyBusPayload
  WeaveRebuildFailed :: Channel 'Global Types.CommandError
  SmeltRebuildAnchors :: Channel 'Global Types.SmeltRebuildAnchorsCommand
  SmeltRebuildAnchorsOk :: Channel 'Global Types.EmptyBusPayload
  SmeltRebuildAnchorsFailed :: Channel 'Global Types.CommandError
  SettingsThemeChanged :: Channel 'Global Types.SettingsThemeChangedEvent
  SettingsLineNumbersToggled :: Channel 'Global Types.EmptyBusPayload
  SettingsLocaleChanged :: Channel 'Global Types.SettingsLocaleChangedEvent
  SettingsHoverDelayChanged :: Channel 'Global Types.SettingsHoverDelayChangedEvent
  BusResumeGap :: Channel 'Global Types.BusResumeGap
  SessionJoined :: Channel 'Global Types.SessionJoinedEvent
  SessionLeft :: Channel 'Global Types.SessionLeftEvent
channelName :: Channel scope payload -> Text
channelName YieldCreated = "yield:created"
channelName YieldCloned = "yield:cloned"
channelName YieldUpdated = "yield:updated"
channelName YieldMoved = "yield:moved"
channelName YieldRepresentationAdded = "yield:representation-added"
channelName YieldRepresentationRemoved = "yield:representation-removed"
channelName YieldCreate = "yield:create"
channelName YieldClonePersist = "yield:clone-persist"
channelName YieldUpdate = "yield:update"
channelName YieldClone = "yield:clone"
channelName YieldCloneTokenRequested = "yield:clone-token-requested"
channelName YieldCloneResourceRequested = "yield:clone-resource-requested"
channelName YieldCloneCreate = "yield:clone-create"
channelName YieldCreateOk = "yield:create-ok"
channelName YieldCreateFailed = "yield:create-failed"
channelName YieldClonePersistOk = "yield:clone-persist-ok"
channelName YieldClonePersistFailed = "yield:clone-persist-failed"
channelName YieldUpdateOk = "yield:update-ok"
channelName YieldUpdateFailed = "yield:update-failed"
channelName YieldCloneTokenGenerated = "yield:clone-token-generated"
channelName YieldCloneTokenFailed = "yield:clone-token-failed"
channelName YieldCloneResourceResult = "yield:clone-resource-result"
channelName YieldCloneResourceFailed = "yield:clone-resource-failed"
channelName YieldCloneCreated = "yield:clone-created"
channelName YieldCloneCreateFailed = "yield:clone-create-failed"
channelName MarkAdded = "mark:added"
channelName MarkRemoved = "mark:removed"
channelName MarkBodyUpdated = "mark:body-updated"
channelName MarkEntityTagAdded = "mark:entity-tag-added"
channelName MarkEntityTagRemoved = "mark:entity-tag-removed"
channelName MarkArchived = "mark:archived"
channelName MarkUnarchived = "mark:unarchived"
channelName MarkCreateRequest = "mark:create-request"
channelName MarkDelete = "mark:delete"
channelName MarkUpdateBody = "mark:update-body"
channelName MarkArchive = "mark:archive"
channelName MarkUnarchive = "mark:unarchive"
channelName MarkUpdateEntityTypes = "mark:update-entity-types"
channelName MarkCreateOk = "mark:create-ok"
channelName MarkCreateFailed = "mark:create-failed"
channelName MarkCommit = "mark:commit"
channelName MarkCommitOk = "mark:commit-ok"
channelName MarkCommitFailed = "mark:commit-failed"
channelName MarkDeleteOk = "mark:delete-ok"
channelName MarkDeleteFailed = "mark:delete-failed"
channelName MarkArchiveOk = "mark:archive-ok"
channelName MarkArchiveFailed = "mark:archive-failed"
channelName MarkUnarchiveOk = "mark:unarchive-ok"
channelName MarkUnarchiveFailed = "mark:unarchive-failed"
channelName MarkUpdateEntityTypesOk = "mark:update-entity-types-ok"
channelName MarkUpdateEntityTypesFailed = "mark:update-entity-types-failed"
channelName MarkBodyUpdateFailed = "mark:body-update-failed"
channelName MarkRequested = "mark:requested"
channelName MarkSubmit = "mark:submit"
channelName MarkDelegateTimeout = "mark:delegate-timeout"
channelName MarkCreateError = "mark:create-error"
channelName MarkDeleteError = "mark:delete-error"
channelName BindBodyError = "bind:body-error"
channelName FrameEntityTypeAdded = "frame:entity-type-added"
channelName FrameTagSchemaAdded = "frame:tag-schema-added"
channelName FrameAddEntityType = "frame:add-entity-type"
channelName FrameAddTagSchema = "frame:add-tag-schema"
channelName FrameEntityTypeAddOk = "frame:entity-type-add-ok"
channelName FrameEntityTypeAddFailed = "frame:entity-type-add-failed"
channelName FrameTagSchemaAddOk = "frame:tag-schema-add-ok"
channelName FrameTagSchemaAddFailed = "frame:tag-schema-add-failed"
channelName PrincipalProfiled = "principal:profiled"
channelName PrincipalProfile = "principal:profile"
channelName BindInitiate = "bind:initiate"
channelName BindUpdateBody = "bind:update-body"
channelName BindBodyUpdated = "bind:body-updated"
channelName BindBodyUpdateFailed = "bind:body-update-failed"
channelName MatchSearchRequested = "match:search-requested"
channelName MatchSearchResults = "match:search-results"
channelName MatchSearchFailed = "match:search-failed"
channelName MatchResourcesRequested = "match:resources-requested"
channelName MatchResourcesResult = "match:resources-result"
channelName MatchResourcesFailed = "match:resources-failed"
channelName MatchLimitsRequested = "match:limits-requested"
channelName MatchLimitsResult = "match:limits-result"
channelName MatchLimitsFailed = "match:limits-failed"
channelName GatherRequested = "gather:requested"
channelName GatherComplete = "gather:complete"
channelName GatherFailed = "gather:failed"
channelName GatherResourceRequested = "gather:resource-requested"
channelName GatherResourceComplete = "gather:resource-complete"
channelName GatherResourceFailed = "gather:resource-failed"
channelName GatherSummaryRequested = "gather:summary-requested"
channelName GatherSummaryResult = "gather:summary-result"
channelName GatherSummaryFailed = "gather:summary-failed"
channelName GatherReferencedByRequested = "gather:referenced-by-requested"
channelName GatherReferencedByResult = "gather:referenced-by-result"
channelName GatherReferencedByFailed = "gather:referenced-by-failed"
channelName GatherLimitsRequested = "gather:limits-requested"
channelName GatherLimitsResult = "gather:limits-result"
channelName GatherLimitsFailed = "gather:limits-failed"
channelName BrowseResourceRequested = "browse:resource-requested"
channelName BrowseResourceResult = "browse:resource-result"
channelName BrowseResourceFailed = "browse:resource-failed"
channelName BrowseResourcesRequested = "browse:resources-requested"
channelName BrowseResourcesResult = "browse:resources-result"
channelName BrowseResourcesFailed = "browse:resources-failed"
channelName BrowseAnnotationRequested = "browse:annotation-requested"
channelName BrowseAnnotationResult = "browse:annotation-result"
channelName BrowseAnnotationFailed = "browse:annotation-failed"
channelName BrowseEventsRequested = "browse:events-requested"
channelName BrowseEventsResult = "browse:events-result"
channelName BrowseEventsFailed = "browse:events-failed"
channelName BrowseAnnotationHistoryRequested = "browse:annotation-history-requested"
channelName BrowseAnnotationHistoryResult = "browse:annotation-history-result"
channelName BrowseAnnotationHistoryFailed = "browse:annotation-history-failed"
channelName BrowseEntityTypesRequested = "browse:entity-types-requested"
channelName BrowseEntityTypesResult = "browse:entity-types-result"
channelName BrowseEntityTypesFailed = "browse:entity-types-failed"
channelName BrowseTagSchemasRequested = "browse:tag-schemas-requested"
channelName BrowseTagSchemasResult = "browse:tag-schemas-result"
channelName BrowseTagSchemasFailed = "browse:tag-schemas-failed"
channelName BrowseEnginesRequested = "browse:engines-requested"
channelName BrowseEnginesResult = "browse:engines-result"
channelName BrowseEnginesFailed = "browse:engines-failed"
channelName BrowseProfilesRequested = "browse:profiles-requested"
channelName BrowseProfilesResult = "browse:profiles-result"
channelName BrowseProfilesFailed = "browse:profiles-failed"
channelName BrowseKbRequested = "browse:kb-requested"
channelName BrowseKbResult = "browse:kb-result"
channelName BrowseKbFailed = "browse:kb-failed"
channelName BrowseDirectoryRequested = "browse:directory-requested"
channelName BrowseDirectoryResult = "browse:directory-result"
channelName BrowseDirectoryFailed = "browse:directory-failed"
channelName BrowseClick = "browse:click"
channelName BrowseResourceOpen = "browse:resource-open"
channelName BrowseResourceViewed = "browse:resource-viewed"
channelName BrowseEntityTypeClicked = "browse:entity-type-clicked"
channelName PanelToggle = "panel:toggle"
channelName PanelOpen = "panel:open"
channelName PanelClose = "panel:close"
channelName ShellSidebarToggle = "shell:sidebar-toggle"
channelName TabsClose = "tabs:close"
channelName TabsReorder = "tabs:reorder"
channelName NavLinkClicked = "nav:link-clicked"
channelName NavPush = "nav:push"
channelName NavExternal = "nav:external"
channelName BeckonHover = "beckon:hover"
channelName BeckonFocus = "beckon:focus"
channelName BeckonSparkle = "beckon:sparkle"
channelName JobStarted = "job:started"
channelName JobAssigned = "job:assigned"
channelName JobCompleted = "job:completed"
channelName JobFailed = "job:failed"
channelName JobStart = "job:start"
channelName JobAssign = "job:assign"
channelName JobReportProgress = "job:report-progress"
channelName JobComplete = "job:complete"
channelName JobFail = "job:fail"
channelName JobCheckpoint = "job:checkpoint"
channelName JobQueued = "job:queued"
channelName JobCancelRequested = "job:cancel-requested"
channelName JobCancel = "job:cancel"
channelName JobLimitsRequested = "job:limits-requested"
channelName JobLimitsResult = "job:limits-result"
channelName JobLimitsFailed = "job:limits-failed"
channelName JobStatusRequested = "job:status-requested"
channelName JobCreate = "job:create"
channelName JobClaim = "job:claim"
channelName JobStatusResult = "job:status-result"
channelName JobStatusFailed = "job:status-failed"
channelName JobCreated = "job:created"
channelName JobCreateFailed = "job:create-failed"
channelName JobClaimed = "job:claimed"
channelName JobClaimFailed = "job:claim-failed"
channelName JobCancelOk = "job:cancel-ok"
channelName JobCancelFailed = "job:cancel-failed"
channelName WeaveApplied = "weave:applied"
channelName SmeltSettled = "smelt:settled"
channelName WeaveRebuild = "weave:rebuild"
channelName WeaveRebuildOk = "weave:rebuild-ok"
channelName WeaveRebuildFailed = "weave:rebuild-failed"
channelName SmeltRebuildAnchors = "smelt:rebuild-anchors"
channelName SmeltRebuildAnchorsOk = "smelt:rebuild-anchors-ok"
channelName SmeltRebuildAnchorsFailed = "smelt:rebuild-anchors-failed"
channelName SettingsThemeChanged = "settings:theme-changed"
channelName SettingsLineNumbersToggled = "settings:line-numbers-toggled"
channelName SettingsLocaleChanged = "settings:locale-changed"
channelName SettingsHoverDelayChanged = "settings:hover-delay-changed"
channelName BusResumeGap = "bus:resume-gap"
channelName SessionJoined = "session:joined"
channelName SessionLeft = "session:left"
channelNames :: [Text]
channelNames = ["yield:created", "yield:cloned", "yield:updated", "yield:moved", "yield:representation-added", "yield:representation-removed", "yield:create", "yield:clone-persist", "yield:update", "yield:clone", "yield:clone-token-requested", "yield:clone-resource-requested", "yield:clone-create", "yield:create-ok", "yield:create-failed", "yield:clone-persist-ok", "yield:clone-persist-failed", "yield:update-ok", "yield:update-failed", "yield:clone-token-generated", "yield:clone-token-failed", "yield:clone-resource-result", "yield:clone-resource-failed", "yield:clone-created", "yield:clone-create-failed", "mark:added", "mark:removed", "mark:body-updated", "mark:entity-tag-added", "mark:entity-tag-removed", "mark:archived", "mark:unarchived", "mark:create-request", "mark:delete", "mark:update-body", "mark:archive", "mark:unarchive", "mark:update-entity-types", "mark:create-ok", "mark:create-failed", "mark:commit", "mark:commit-ok", "mark:commit-failed", "mark:delete-ok", "mark:delete-failed", "mark:archive-ok", "mark:archive-failed", "mark:unarchive-ok", "mark:unarchive-failed", "mark:update-entity-types-ok", "mark:update-entity-types-failed", "mark:body-update-failed", "mark:requested", "mark:submit", "mark:delegate-timeout", "mark:create-error", "mark:delete-error", "bind:body-error", "frame:entity-type-added", "frame:tag-schema-added", "frame:add-entity-type", "frame:add-tag-schema", "frame:entity-type-add-ok", "frame:entity-type-add-failed", "frame:tag-schema-add-ok", "frame:tag-schema-add-failed", "principal:profiled", "principal:profile", "bind:initiate", "bind:update-body", "bind:body-updated", "bind:body-update-failed", "match:search-requested", "match:search-results", "match:search-failed", "match:resources-requested", "match:resources-result", "match:resources-failed", "match:limits-requested", "match:limits-result", "match:limits-failed", "gather:requested", "gather:complete", "gather:failed", "gather:resource-requested", "gather:resource-complete", "gather:resource-failed", "gather:summary-requested", "gather:summary-result", "gather:summary-failed", "gather:referenced-by-requested", "gather:referenced-by-result", "gather:referenced-by-failed", "gather:limits-requested", "gather:limits-result", "gather:limits-failed", "browse:resource-requested", "browse:resource-result", "browse:resource-failed", "browse:resources-requested", "browse:resources-result", "browse:resources-failed", "browse:annotation-requested", "browse:annotation-result", "browse:annotation-failed", "browse:events-requested", "browse:events-result", "browse:events-failed", "browse:annotation-history-requested", "browse:annotation-history-result", "browse:annotation-history-failed", "browse:entity-types-requested", "browse:entity-types-result", "browse:entity-types-failed", "browse:tag-schemas-requested", "browse:tag-schemas-result", "browse:tag-schemas-failed", "browse:engines-requested", "browse:engines-result", "browse:engines-failed", "browse:profiles-requested", "browse:profiles-result", "browse:profiles-failed", "browse:kb-requested", "browse:kb-result", "browse:kb-failed", "browse:directory-requested", "browse:directory-result", "browse:directory-failed", "browse:click", "browse:resource-open", "browse:resource-viewed", "browse:entity-type-clicked", "panel:toggle", "panel:open", "panel:close", "shell:sidebar-toggle", "tabs:close", "tabs:reorder", "nav:link-clicked", "nav:push", "nav:external", "beckon:hover", "beckon:focus", "beckon:sparkle", "job:started", "job:assigned", "job:completed", "job:failed", "job:start", "job:assign", "job:report-progress", "job:complete", "job:fail", "job:checkpoint", "job:queued", "job:cancel-requested", "job:cancel", "job:limits-requested", "job:limits-result", "job:limits-failed", "job:status-requested", "job:create", "job:claim", "job:status-result", "job:status-failed", "job:created", "job:create-failed", "job:claimed", "job:claim-failed", "job:cancel-ok", "job:cancel-failed", "weave:applied", "smelt:settled", "weave:rebuild", "weave:rebuild-ok", "weave:rebuild-failed", "smelt:rebuild-anchors", "smelt:rebuild-anchors-ok", "smelt:rebuild-anchors-failed", "settings:theme-changed", "settings:line-numbers-toggled", "settings:locale-changed", "settings:hover-delay-changed", "bus:resume-gap", "session:joined", "session:left"]
globalChannels :: [Text]
globalChannels = ["job:report-progress", "job:complete", "job:fail", "smelt:settled", "frame:entity-type-added", "frame:tag-schema-added", "yield:created", "yield:updated", "yield:cloned", "yield:moved", "beckon:focus", "beckon:sparkle", "bus:resume-gap", "browse:resource-open", "browse:resource-viewed", "session:joined", "session:left", "browse:click", "bind:body-updated", "bind:body-update-failed", "browse:resource-result", "browse:resource-failed", "browse:resources-result", "browse:resources-failed", "browse:annotation-result", "browse:annotation-failed", "browse:annotation-history-result", "browse:annotation-history-failed", "browse:events-result", "browse:events-failed", "browse:entity-types-result", "browse:entity-types-failed", "browse:tag-schemas-result", "browse:tag-schemas-failed", "browse:engines-result", "browse:engines-failed", "browse:profiles-result", "browse:profiles-failed", "browse:kb-result", "browse:kb-failed", "browse:directory-result", "browse:directory-failed", "frame:entity-type-add-ok", "frame:entity-type-add-failed", "frame:tag-schema-add-ok", "frame:tag-schema-add-failed", "gather:complete", "gather:failed", "gather:resource-complete", "gather:resource-failed", "gather:summary-result", "gather:summary-failed", "gather:referenced-by-result", "gather:referenced-by-failed", "gather:limits-result", "gather:limits-failed", "job:created", "job:create-failed", "job:status-result", "job:status-failed", "job:limits-result", "job:limits-failed", "job:cancel-ok", "job:cancel-failed", "job:claimed", "job:claim-failed", "mark:create-ok", "mark:create-failed", "mark:commit-ok", "mark:commit-failed", "mark:delete-ok", "mark:delete-failed", "mark:archive-ok", "mark:archive-failed", "mark:unarchive-ok", "mark:unarchive-failed", "mark:update-entity-types-ok", "mark:update-entity-types-failed", "match:search-results", "match:search-failed", "match:resources-result", "match:resources-failed", "match:limits-result", "match:limits-failed", "weave:rebuild-ok", "weave:rebuild-failed", "smelt:rebuild-anchors-ok", "smelt:rebuild-anchors-failed", "yield:create-ok", "yield:create-failed", "yield:clone-persist-ok", "yield:clone-persist-failed", "yield:update-ok", "yield:update-failed", "yield:clone-created", "yield:clone-create-failed", "yield:clone-resource-result", "yield:clone-resource-failed", "yield:clone-token-generated", "yield:clone-token-failed"]
scopedChannels :: [Text]
scopedChannels = ["mark:body-updated", "yield:representation-added", "yield:representation-removed", "mark:added", "mark:removed", "mark:entity-tag-added", "mark:entity-tag-removed", "mark:archived", "mark:unarchived", "job:started", "job:assigned", "job:completed", "job:failed"]
channelSchema :: Channel scope payload -> Text
channelSchema YieldCreated = "StoredEventResponse"
channelSchema YieldCloned = "StoredEventResponse"
channelSchema YieldUpdated = "StoredEventResponse"
channelSchema YieldMoved = "StoredEventResponse"
channelSchema YieldRepresentationAdded = "StoredEventResponse"
channelSchema YieldRepresentationRemoved = "StoredEventResponse"
channelSchema YieldCreate = "YieldCreateCommand"
channelSchema YieldClonePersist = "YieldClonePersistCommand"
channelSchema YieldUpdate = "YieldUpdateCommand"
channelSchema YieldClone = "EmptyBusPayload"
channelSchema YieldCloneTokenRequested = "YieldCloneTokenRequest"
channelSchema YieldCloneResourceRequested = "YieldCloneResourceRequest"
channelSchema YieldCloneCreate = "YieldCloneCreateCommand"
channelSchema YieldCreateOk = "YieldCreateOk"
channelSchema YieldCreateFailed = "CommandError"
channelSchema YieldClonePersistOk = "YieldClonePersistOk"
channelSchema YieldClonePersistFailed = "CommandError"
channelSchema YieldUpdateOk = "YieldUpdateOk"
channelSchema YieldUpdateFailed = "CommandError"
channelSchema YieldCloneTokenGenerated = "CloneResourceWithTokenResponseBusEnvelope"
channelSchema YieldCloneTokenFailed = "CommandError"
channelSchema YieldCloneResourceResult = "GetResourceByTokenResponseBusEnvelope"
channelSchema YieldCloneResourceFailed = "CommandError"
channelSchema YieldCloneCreated = "YieldCloneCreated"
channelSchema YieldCloneCreateFailed = "CommandError"
channelSchema MarkAdded = "EnrichedResourceEvent"
channelSchema MarkRemoved = "StoredEventResponse"
channelSchema MarkBodyUpdated = "EnrichedResourceEvent"
channelSchema MarkEntityTagAdded = "StoredEventResponse"
channelSchema MarkEntityTagRemoved = "StoredEventResponse"
channelSchema MarkArchived = "StoredEventResponse"
channelSchema MarkUnarchived = "StoredEventResponse"
channelSchema MarkCreateRequest = "MarkCreateRequest"
channelSchema MarkDelete = "MarkDeleteCommand"
channelSchema MarkUpdateBody = "MarkUpdateBodyCommand"
channelSchema MarkArchive = "MarkArchiveCommand"
channelSchema MarkUnarchive = "MarkUnarchiveCommand"
channelSchema MarkUpdateEntityTypes = "MarkUpdateEntityTypesCommand"
channelSchema MarkCreateOk = "MarkCreateOk"
channelSchema MarkCreateFailed = "CommandError"
channelSchema MarkCommit = "MarkCommitCommand"
channelSchema MarkCommitOk = "MarkCommitOk"
channelSchema MarkCommitFailed = "CommandError"
channelSchema MarkDeleteOk = "MarkDeleteOk"
channelSchema MarkDeleteFailed = "CommandError"
channelSchema MarkArchiveOk = "EmptyBusPayload"
channelSchema MarkArchiveFailed = "CommandError"
channelSchema MarkUnarchiveOk = "EmptyBusPayload"
channelSchema MarkUnarchiveFailed = "CommandError"
channelSchema MarkUpdateEntityTypesOk = "EmptyBusPayload"
channelSchema MarkUpdateEntityTypesFailed = "CommandError"
channelSchema MarkBodyUpdateFailed = "CommandError"
channelSchema MarkRequested = "MarkRequestedEvent"
channelSchema MarkSubmit = "MarkSubmitEvent"
channelSchema MarkDelegateTimeout = "MarkDelegateTimeoutEvent"
channelSchema MarkCreateError = "ResourceErrorEvent"
channelSchema MarkDeleteError = "ResourceErrorEvent"
channelSchema BindBodyError = "ResourceErrorEvent"
channelSchema FrameEntityTypeAdded = "StoredEventResponse"
channelSchema FrameTagSchemaAdded = "StoredEventResponse"
channelSchema FrameAddEntityType = "FrameAddEntityTypeCommand"
channelSchema FrameAddTagSchema = "FrameAddTagSchemaCommand"
channelSchema FrameEntityTypeAddOk = "EmptyBusPayload"
channelSchema FrameEntityTypeAddFailed = "CommandError"
channelSchema FrameTagSchemaAddOk = "EmptyBusPayload"
channelSchema FrameTagSchemaAddFailed = "CommandError"
channelSchema PrincipalProfiled = "StoredEventResponse"
channelSchema PrincipalProfile = "PrincipalProfileCommand"
channelSchema BindInitiate = "BindInitiateCommand"
channelSchema BindUpdateBody = "BindUpdateBodyCommand"
channelSchema BindBodyUpdated = "BindBodyUpdated"
channelSchema BindBodyUpdateFailed = "CommandError"
channelSchema MatchSearchRequested = "MatchSearchRequest"
channelSchema MatchSearchResults = "MatchSearchResult"
channelSchema MatchSearchFailed = "MatchSearchFailed"
channelSchema MatchResourcesRequested = "MatchResourcesRequest"
channelSchema MatchResourcesResult = "MatchResourcesResult"
channelSchema MatchResourcesFailed = "CommandError"
channelSchema MatchLimitsRequested = "InferenceLimitsRequest"
channelSchema MatchLimitsResult = "InferenceLimitsResult"
channelSchema MatchLimitsFailed = "CommandError"
channelSchema GatherRequested = "GatherAnnotationRequest"
channelSchema GatherComplete = "GatherAnnotationComplete"
channelSchema GatherFailed = "GatherFailed"
channelSchema GatherResourceRequested = "GatherResourceRequest"
channelSchema GatherResourceComplete = "GatherResourceComplete"
channelSchema GatherResourceFailed = "GatherResourceFailed"
channelSchema GatherSummaryRequested = "GatherSummaryRequest"
channelSchema GatherSummaryResult = "ContextualSummaryResponseBusEnvelope"
channelSchema GatherSummaryFailed = "CommandError"
channelSchema GatherReferencedByRequested = "GatherReferencedByRequest"
channelSchema GatherReferencedByResult = "GatherReferencedByResult"
channelSchema GatherReferencedByFailed = "CommandError"
channelSchema GatherLimitsRequested = "InferenceLimitsRequest"
channelSchema GatherLimitsResult = "InferenceLimitsResult"
channelSchema GatherLimitsFailed = "CommandError"
channelSchema BrowseResourceRequested = "BrowseResourceRequest"
channelSchema BrowseResourceResult = "BrowseResourceResult"
channelSchema BrowseResourceFailed = "CommandError"
channelSchema BrowseResourcesRequested = "BrowseResourcesRequest"
channelSchema BrowseResourcesResult = "BrowseResourcesResult"
channelSchema BrowseResourcesFailed = "CommandError"
channelSchema BrowseAnnotationRequested = "BrowseAnnotationRequest"
channelSchema BrowseAnnotationResult = "BrowseAnnotationResult"
channelSchema BrowseAnnotationFailed = "CommandError"
channelSchema BrowseEventsRequested = "BrowseEventsRequest"
channelSchema BrowseEventsResult = "BrowseEventsResult"
channelSchema BrowseEventsFailed = "CommandError"
channelSchema BrowseAnnotationHistoryRequested = "BrowseAnnotationHistoryRequest"
channelSchema BrowseAnnotationHistoryResult = "BrowseAnnotationHistoryResult"
channelSchema BrowseAnnotationHistoryFailed = "CommandError"
channelSchema BrowseEntityTypesRequested = "BrowseEntityTypesRequest"
channelSchema BrowseEntityTypesResult = "BrowseEntityTypesResult"
channelSchema BrowseEntityTypesFailed = "CommandError"
channelSchema BrowseTagSchemasRequested = "BrowseTagSchemasRequest"
channelSchema BrowseTagSchemasResult = "BrowseTagSchemasResult"
channelSchema BrowseTagSchemasFailed = "CommandError"
channelSchema BrowseEnginesRequested = "BrowseEnginesRequest"
channelSchema BrowseEnginesResult = "BrowseEnginesResult"
channelSchema BrowseEnginesFailed = "CommandError"
channelSchema BrowseProfilesRequested = "BrowseProfilesRequest"
channelSchema BrowseProfilesResult = "BrowseProfilesResult"
channelSchema BrowseProfilesFailed = "CommandError"
channelSchema BrowseKbRequested = "BrowseKbRequest"
channelSchema BrowseKbResult = "BrowseKbResult"
channelSchema BrowseKbFailed = "CommandError"
channelSchema BrowseDirectoryRequested = "BrowseDirectoryRequest"
channelSchema BrowseDirectoryResult = "BrowseDirectoryResult"
channelSchema BrowseDirectoryFailed = "BrowseDirectoryFailed"
channelSchema BrowseClick = "BrowseClickEvent"
channelSchema BrowseResourceOpen = "BrowseResourceOpenEvent"
channelSchema BrowseResourceViewed = "BrowseResourceViewedEvent"
channelSchema BrowseEntityTypeClicked = "BrowseEntityTypeClickedEvent"
channelSchema PanelToggle = "BrowsePanelToggleEvent"
channelSchema PanelOpen = "BrowsePanelOpenEvent"
channelSchema PanelClose = "EmptyBusPayload"
channelSchema ShellSidebarToggle = "EmptyBusPayload"
channelSchema TabsClose = "BrowseResourceCloseEvent"
channelSchema TabsReorder = "BrowseResourceReorderEvent"
channelSchema NavLinkClicked = "BrowseLinkClickedEvent"
channelSchema NavPush = "BrowseRouterPushEvent"
channelSchema NavExternal = "BrowseExternalNavigateEvent"
channelSchema BeckonHover = "BeckonHoverEvent"
channelSchema BeckonFocus = "BeckonFocusEvent"
channelSchema BeckonSparkle = "BeckonSparkleEvent"
channelSchema JobStarted = "StoredEventResponse"
channelSchema JobAssigned = "StoredEventResponse"
channelSchema JobCompleted = "StoredEventResponse"
channelSchema JobFailed = "StoredEventResponse"
channelSchema JobStart = "JobStartCommand"
channelSchema JobAssign = "JobAssignCommand"
channelSchema JobReportProgress = "JobReportProgressCommand"
channelSchema JobComplete = "JobCompleteCommand"
channelSchema JobFail = "JobFailCommand"
channelSchema JobCheckpoint = "JobCheckpointCommand"
channelSchema JobQueued = "JobQueuedEvent"
channelSchema JobCancelRequested = "JobCancelRequest"
channelSchema JobCancel = "JobCancelCommand"
channelSchema JobLimitsRequested = "InferenceLimitsRequest"
channelSchema JobLimitsResult = "InferenceLimitsResult"
channelSchema JobLimitsFailed = "CommandError"
channelSchema JobStatusRequested = "JobStatusRequest"
channelSchema JobCreate = "JobCreateCommand"
channelSchema JobClaim = "JobClaimCommand"
channelSchema JobStatusResult = "JobStatusResult"
channelSchema JobStatusFailed = "CommandError"
channelSchema JobCreated = "JobCreatedResult"
channelSchema JobCreateFailed = "CommandError"
channelSchema JobClaimed = "JobClaimedResult"
channelSchema JobClaimFailed = "CommandError"
channelSchema JobCancelOk = "JobCancelResultBusEnvelope"
channelSchema JobCancelFailed = "CommandError"
channelSchema WeaveApplied = "WeaveApplied"
channelSchema SmeltSettled = "SmeltSettled"
channelSchema WeaveRebuild = "WeaveRebuildCommand"
channelSchema WeaveRebuildOk = "EmptyBusPayload"
channelSchema WeaveRebuildFailed = "CommandError"
channelSchema SmeltRebuildAnchors = "SmeltRebuildAnchorsCommand"
channelSchema SmeltRebuildAnchorsOk = "EmptyBusPayload"
channelSchema SmeltRebuildAnchorsFailed = "CommandError"
channelSchema SettingsThemeChanged = "SettingsThemeChangedEvent"
channelSchema SettingsLineNumbersToggled = "EmptyBusPayload"
channelSchema SettingsLocaleChanged = "SettingsLocaleChangedEvent"
channelSchema SettingsHoverDelayChanged = "SettingsHoverDelayChangedEvent"
channelSchema BusResumeGap = "BusResumeGap"
channelSchema SessionJoined = "SessionJoinedEvent"
channelSchema SessionLeft = "SessionLeftEvent"
persistedEventTypes :: [Text]
persistedEventTypes = ["yield:created", "yield:cloned", "yield:updated", "yield:moved", "yield:representation-added", "yield:representation-removed", "mark:added", "mark:removed", "mark:body-updated", "mark:entity-tag-added", "mark:entity-tag-removed", "mark:archived", "mark:unarchived", "frame:entity-type-added", "frame:tag-schema-added", "principal:profiled", "job:started", "job:assigned", "job:completed", "job:failed"]
channelIsScoped :: Channel scope payload -> Bool
channelIsScoped YieldCreated = False
channelIsScoped YieldCloned = False
channelIsScoped YieldUpdated = False
channelIsScoped YieldMoved = False
channelIsScoped YieldRepresentationAdded = True
channelIsScoped YieldRepresentationRemoved = True
channelIsScoped YieldCreate = False
channelIsScoped YieldClonePersist = False
channelIsScoped YieldUpdate = False
channelIsScoped YieldClone = False
channelIsScoped YieldCloneTokenRequested = False
channelIsScoped YieldCloneResourceRequested = False
channelIsScoped YieldCloneCreate = False
channelIsScoped YieldCreateOk = False
channelIsScoped YieldCreateFailed = False
channelIsScoped YieldClonePersistOk = False
channelIsScoped YieldClonePersistFailed = False
channelIsScoped YieldUpdateOk = False
channelIsScoped YieldUpdateFailed = False
channelIsScoped YieldCloneTokenGenerated = False
channelIsScoped YieldCloneTokenFailed = False
channelIsScoped YieldCloneResourceResult = False
channelIsScoped YieldCloneResourceFailed = False
channelIsScoped YieldCloneCreated = False
channelIsScoped YieldCloneCreateFailed = False
channelIsScoped MarkAdded = True
channelIsScoped MarkRemoved = True
channelIsScoped MarkBodyUpdated = True
channelIsScoped MarkEntityTagAdded = True
channelIsScoped MarkEntityTagRemoved = True
channelIsScoped MarkArchived = True
channelIsScoped MarkUnarchived = True
channelIsScoped MarkCreateRequest = False
channelIsScoped MarkDelete = False
channelIsScoped MarkUpdateBody = False
channelIsScoped MarkArchive = False
channelIsScoped MarkUnarchive = False
channelIsScoped MarkUpdateEntityTypes = False
channelIsScoped MarkCreateOk = False
channelIsScoped MarkCreateFailed = False
channelIsScoped MarkCommit = False
channelIsScoped MarkCommitOk = False
channelIsScoped MarkCommitFailed = False
channelIsScoped MarkDeleteOk = False
channelIsScoped MarkDeleteFailed = False
channelIsScoped MarkArchiveOk = False
channelIsScoped MarkArchiveFailed = False
channelIsScoped MarkUnarchiveOk = False
channelIsScoped MarkUnarchiveFailed = False
channelIsScoped MarkUpdateEntityTypesOk = False
channelIsScoped MarkUpdateEntityTypesFailed = False
channelIsScoped MarkBodyUpdateFailed = False
channelIsScoped MarkRequested = False
channelIsScoped MarkSubmit = False
channelIsScoped MarkDelegateTimeout = False
channelIsScoped MarkCreateError = False
channelIsScoped MarkDeleteError = False
channelIsScoped BindBodyError = False
channelIsScoped FrameEntityTypeAdded = False
channelIsScoped FrameTagSchemaAdded = False
channelIsScoped FrameAddEntityType = False
channelIsScoped FrameAddTagSchema = False
channelIsScoped FrameEntityTypeAddOk = False
channelIsScoped FrameEntityTypeAddFailed = False
channelIsScoped FrameTagSchemaAddOk = False
channelIsScoped FrameTagSchemaAddFailed = False
channelIsScoped PrincipalProfiled = False
channelIsScoped PrincipalProfile = False
channelIsScoped BindInitiate = False
channelIsScoped BindUpdateBody = False
channelIsScoped BindBodyUpdated = False
channelIsScoped BindBodyUpdateFailed = False
channelIsScoped MatchSearchRequested = False
channelIsScoped MatchSearchResults = False
channelIsScoped MatchSearchFailed = False
channelIsScoped MatchResourcesRequested = False
channelIsScoped MatchResourcesResult = False
channelIsScoped MatchResourcesFailed = False
channelIsScoped MatchLimitsRequested = False
channelIsScoped MatchLimitsResult = False
channelIsScoped MatchLimitsFailed = False
channelIsScoped GatherRequested = False
channelIsScoped GatherComplete = False
channelIsScoped GatherFailed = False
channelIsScoped GatherResourceRequested = False
channelIsScoped GatherResourceComplete = False
channelIsScoped GatherResourceFailed = False
channelIsScoped GatherSummaryRequested = False
channelIsScoped GatherSummaryResult = False
channelIsScoped GatherSummaryFailed = False
channelIsScoped GatherReferencedByRequested = False
channelIsScoped GatherReferencedByResult = False
channelIsScoped GatherReferencedByFailed = False
channelIsScoped GatherLimitsRequested = False
channelIsScoped GatherLimitsResult = False
channelIsScoped GatherLimitsFailed = False
channelIsScoped BrowseResourceRequested = False
channelIsScoped BrowseResourceResult = False
channelIsScoped BrowseResourceFailed = False
channelIsScoped BrowseResourcesRequested = False
channelIsScoped BrowseResourcesResult = False
channelIsScoped BrowseResourcesFailed = False
channelIsScoped BrowseAnnotationRequested = False
channelIsScoped BrowseAnnotationResult = False
channelIsScoped BrowseAnnotationFailed = False
channelIsScoped BrowseEventsRequested = False
channelIsScoped BrowseEventsResult = False
channelIsScoped BrowseEventsFailed = False
channelIsScoped BrowseAnnotationHistoryRequested = False
channelIsScoped BrowseAnnotationHistoryResult = False
channelIsScoped BrowseAnnotationHistoryFailed = False
channelIsScoped BrowseEntityTypesRequested = False
channelIsScoped BrowseEntityTypesResult = False
channelIsScoped BrowseEntityTypesFailed = False
channelIsScoped BrowseTagSchemasRequested = False
channelIsScoped BrowseTagSchemasResult = False
channelIsScoped BrowseTagSchemasFailed = False
channelIsScoped BrowseEnginesRequested = False
channelIsScoped BrowseEnginesResult = False
channelIsScoped BrowseEnginesFailed = False
channelIsScoped BrowseProfilesRequested = False
channelIsScoped BrowseProfilesResult = False
channelIsScoped BrowseProfilesFailed = False
channelIsScoped BrowseKbRequested = False
channelIsScoped BrowseKbResult = False
channelIsScoped BrowseKbFailed = False
channelIsScoped BrowseDirectoryRequested = False
channelIsScoped BrowseDirectoryResult = False
channelIsScoped BrowseDirectoryFailed = False
channelIsScoped BrowseClick = False
channelIsScoped BrowseResourceOpen = False
channelIsScoped BrowseResourceViewed = False
channelIsScoped BrowseEntityTypeClicked = False
channelIsScoped PanelToggle = False
channelIsScoped PanelOpen = False
channelIsScoped PanelClose = False
channelIsScoped ShellSidebarToggle = False
channelIsScoped TabsClose = False
channelIsScoped TabsReorder = False
channelIsScoped NavLinkClicked = False
channelIsScoped NavPush = False
channelIsScoped NavExternal = False
channelIsScoped BeckonHover = False
channelIsScoped BeckonFocus = False
channelIsScoped BeckonSparkle = False
channelIsScoped JobStarted = True
channelIsScoped JobAssigned = True
channelIsScoped JobCompleted = True
channelIsScoped JobFailed = True
channelIsScoped JobStart = False
channelIsScoped JobAssign = False
channelIsScoped JobReportProgress = False
channelIsScoped JobComplete = False
channelIsScoped JobFail = False
channelIsScoped JobCheckpoint = False
channelIsScoped JobQueued = False
channelIsScoped JobCancelRequested = False
channelIsScoped JobCancel = False
channelIsScoped JobLimitsRequested = False
channelIsScoped JobLimitsResult = False
channelIsScoped JobLimitsFailed = False
channelIsScoped JobStatusRequested = False
channelIsScoped JobCreate = False
channelIsScoped JobClaim = False
channelIsScoped JobStatusResult = False
channelIsScoped JobStatusFailed = False
channelIsScoped JobCreated = False
channelIsScoped JobCreateFailed = False
channelIsScoped JobClaimed = False
channelIsScoped JobClaimFailed = False
channelIsScoped JobCancelOk = False
channelIsScoped JobCancelFailed = False
channelIsScoped WeaveApplied = False
channelIsScoped SmeltSettled = False
channelIsScoped WeaveRebuild = False
channelIsScoped WeaveRebuildOk = False
channelIsScoped WeaveRebuildFailed = False
channelIsScoped SmeltRebuildAnchors = False
channelIsScoped SmeltRebuildAnchorsOk = False
channelIsScoped SmeltRebuildAnchorsFailed = False
channelIsScoped SettingsThemeChanged = False
channelIsScoped SettingsLineNumbersToggled = False
channelIsScoped SettingsLocaleChanged = False
channelIsScoped SettingsHoverDelayChanged = False
channelIsScoped BusResumeGap = False
channelIsScoped SessionJoined = False
channelIsScoped SessionLeft = False
encodePayload :: Channel scope payload -> payload -> Value
encodePayload YieldCreated = toJSON
encodePayload YieldCloned = toJSON
encodePayload YieldUpdated = toJSON
encodePayload YieldMoved = toJSON
encodePayload YieldRepresentationAdded = toJSON
encodePayload YieldRepresentationRemoved = toJSON
encodePayload YieldCreate = toJSON
encodePayload YieldClonePersist = toJSON
encodePayload YieldUpdate = toJSON
encodePayload YieldClone = toJSON
encodePayload YieldCloneTokenRequested = toJSON
encodePayload YieldCloneResourceRequested = toJSON
encodePayload YieldCloneCreate = toJSON
encodePayload YieldCreateOk = toJSON
encodePayload YieldCreateFailed = toJSON
encodePayload YieldClonePersistOk = toJSON
encodePayload YieldClonePersistFailed = toJSON
encodePayload YieldUpdateOk = toJSON
encodePayload YieldUpdateFailed = toJSON
encodePayload YieldCloneTokenGenerated = toJSON
encodePayload YieldCloneTokenFailed = toJSON
encodePayload YieldCloneResourceResult = toJSON
encodePayload YieldCloneResourceFailed = toJSON
encodePayload YieldCloneCreated = toJSON
encodePayload YieldCloneCreateFailed = toJSON
encodePayload MarkAdded = toJSON
encodePayload MarkRemoved = toJSON
encodePayload MarkBodyUpdated = toJSON
encodePayload MarkEntityTagAdded = toJSON
encodePayload MarkEntityTagRemoved = toJSON
encodePayload MarkArchived = toJSON
encodePayload MarkUnarchived = toJSON
encodePayload MarkCreateRequest = toJSON
encodePayload MarkDelete = toJSON
encodePayload MarkUpdateBody = toJSON
encodePayload MarkArchive = toJSON
encodePayload MarkUnarchive = toJSON
encodePayload MarkUpdateEntityTypes = toJSON
encodePayload MarkCreateOk = toJSON
encodePayload MarkCreateFailed = toJSON
encodePayload MarkCommit = toJSON
encodePayload MarkCommitOk = toJSON
encodePayload MarkCommitFailed = toJSON
encodePayload MarkDeleteOk = toJSON
encodePayload MarkDeleteFailed = toJSON
encodePayload MarkArchiveOk = toJSON
encodePayload MarkArchiveFailed = toJSON
encodePayload MarkUnarchiveOk = toJSON
encodePayload MarkUnarchiveFailed = toJSON
encodePayload MarkUpdateEntityTypesOk = toJSON
encodePayload MarkUpdateEntityTypesFailed = toJSON
encodePayload MarkBodyUpdateFailed = toJSON
encodePayload MarkRequested = toJSON
encodePayload MarkSubmit = toJSON
encodePayload MarkDelegateTimeout = toJSON
encodePayload MarkCreateError = toJSON
encodePayload MarkDeleteError = toJSON
encodePayload BindBodyError = toJSON
encodePayload FrameEntityTypeAdded = toJSON
encodePayload FrameTagSchemaAdded = toJSON
encodePayload FrameAddEntityType = toJSON
encodePayload FrameAddTagSchema = toJSON
encodePayload FrameEntityTypeAddOk = toJSON
encodePayload FrameEntityTypeAddFailed = toJSON
encodePayload FrameTagSchemaAddOk = toJSON
encodePayload FrameTagSchemaAddFailed = toJSON
encodePayload PrincipalProfiled = toJSON
encodePayload PrincipalProfile = toJSON
encodePayload BindInitiate = toJSON
encodePayload BindUpdateBody = toJSON
encodePayload BindBodyUpdated = toJSON
encodePayload BindBodyUpdateFailed = toJSON
encodePayload MatchSearchRequested = toJSON
encodePayload MatchSearchResults = toJSON
encodePayload MatchSearchFailed = toJSON
encodePayload MatchResourcesRequested = toJSON
encodePayload MatchResourcesResult = toJSON
encodePayload MatchResourcesFailed = toJSON
encodePayload MatchLimitsRequested = toJSON
encodePayload MatchLimitsResult = toJSON
encodePayload MatchLimitsFailed = toJSON
encodePayload GatherRequested = toJSON
encodePayload GatherComplete = toJSON
encodePayload GatherFailed = toJSON
encodePayload GatherResourceRequested = toJSON
encodePayload GatherResourceComplete = toJSON
encodePayload GatherResourceFailed = toJSON
encodePayload GatherSummaryRequested = toJSON
encodePayload GatherSummaryResult = toJSON
encodePayload GatherSummaryFailed = toJSON
encodePayload GatherReferencedByRequested = toJSON
encodePayload GatherReferencedByResult = toJSON
encodePayload GatherReferencedByFailed = toJSON
encodePayload GatherLimitsRequested = toJSON
encodePayload GatherLimitsResult = toJSON
encodePayload GatherLimitsFailed = toJSON
encodePayload BrowseResourceRequested = toJSON
encodePayload BrowseResourceResult = toJSON
encodePayload BrowseResourceFailed = toJSON
encodePayload BrowseResourcesRequested = toJSON
encodePayload BrowseResourcesResult = toJSON
encodePayload BrowseResourcesFailed = toJSON
encodePayload BrowseAnnotationRequested = toJSON
encodePayload BrowseAnnotationResult = toJSON
encodePayload BrowseAnnotationFailed = toJSON
encodePayload BrowseEventsRequested = toJSON
encodePayload BrowseEventsResult = toJSON
encodePayload BrowseEventsFailed = toJSON
encodePayload BrowseAnnotationHistoryRequested = toJSON
encodePayload BrowseAnnotationHistoryResult = toJSON
encodePayload BrowseAnnotationHistoryFailed = toJSON
encodePayload BrowseEntityTypesRequested = toJSON
encodePayload BrowseEntityTypesResult = toJSON
encodePayload BrowseEntityTypesFailed = toJSON
encodePayload BrowseTagSchemasRequested = toJSON
encodePayload BrowseTagSchemasResult = toJSON
encodePayload BrowseTagSchemasFailed = toJSON
encodePayload BrowseEnginesRequested = toJSON
encodePayload BrowseEnginesResult = toJSON
encodePayload BrowseEnginesFailed = toJSON
encodePayload BrowseProfilesRequested = toJSON
encodePayload BrowseProfilesResult = toJSON
encodePayload BrowseProfilesFailed = toJSON
encodePayload BrowseKbRequested = toJSON
encodePayload BrowseKbResult = toJSON
encodePayload BrowseKbFailed = toJSON
encodePayload BrowseDirectoryRequested = toJSON
encodePayload BrowseDirectoryResult = toJSON
encodePayload BrowseDirectoryFailed = toJSON
encodePayload BrowseClick = toJSON
encodePayload BrowseResourceOpen = toJSON
encodePayload BrowseResourceViewed = toJSON
encodePayload BrowseEntityTypeClicked = toJSON
encodePayload PanelToggle = toJSON
encodePayload PanelOpen = toJSON
encodePayload PanelClose = toJSON
encodePayload ShellSidebarToggle = toJSON
encodePayload TabsClose = toJSON
encodePayload TabsReorder = toJSON
encodePayload NavLinkClicked = toJSON
encodePayload NavPush = toJSON
encodePayload NavExternal = toJSON
encodePayload BeckonHover = toJSON
encodePayload BeckonFocus = toJSON
encodePayload BeckonSparkle = toJSON
encodePayload JobStarted = toJSON
encodePayload JobAssigned = toJSON
encodePayload JobCompleted = toJSON
encodePayload JobFailed = toJSON
encodePayload JobStart = toJSON
encodePayload JobAssign = toJSON
encodePayload JobReportProgress = toJSON
encodePayload JobComplete = toJSON
encodePayload JobFail = toJSON
encodePayload JobCheckpoint = toJSON
encodePayload JobQueued = toJSON
encodePayload JobCancelRequested = toJSON
encodePayload JobCancel = toJSON
encodePayload JobLimitsRequested = toJSON
encodePayload JobLimitsResult = toJSON
encodePayload JobLimitsFailed = toJSON
encodePayload JobStatusRequested = toJSON
encodePayload JobCreate = toJSON
encodePayload JobClaim = toJSON
encodePayload JobStatusResult = toJSON
encodePayload JobStatusFailed = toJSON
encodePayload JobCreated = toJSON
encodePayload JobCreateFailed = toJSON
encodePayload JobClaimed = toJSON
encodePayload JobClaimFailed = toJSON
encodePayload JobCancelOk = toJSON
encodePayload JobCancelFailed = toJSON
encodePayload WeaveApplied = toJSON
encodePayload SmeltSettled = toJSON
encodePayload WeaveRebuild = toJSON
encodePayload WeaveRebuildOk = toJSON
encodePayload WeaveRebuildFailed = toJSON
encodePayload SmeltRebuildAnchors = toJSON
encodePayload SmeltRebuildAnchorsOk = toJSON
encodePayload SmeltRebuildAnchorsFailed = toJSON
encodePayload SettingsThemeChanged = toJSON
encodePayload SettingsLineNumbersToggled = toJSON
encodePayload SettingsLocaleChanged = toJSON
encodePayload SettingsHoverDelayChanged = toJSON
encodePayload BusResumeGap = toJSON
encodePayload SessionJoined = toJSON
encodePayload SessionLeft = toJSON
decodePayload :: Channel scope payload -> Value -> Either String payload
decodePayload YieldCreated = parseEither parseJSON . withoutStamps (channelStamps YieldCreated)
decodePayload YieldCloned = parseEither parseJSON . withoutStamps (channelStamps YieldCloned)
decodePayload YieldUpdated = parseEither parseJSON . withoutStamps (channelStamps YieldUpdated)
decodePayload YieldMoved = parseEither parseJSON . withoutStamps (channelStamps YieldMoved)
decodePayload YieldRepresentationAdded = parseEither parseJSON . withoutStamps (channelStamps YieldRepresentationAdded)
decodePayload YieldRepresentationRemoved = parseEither parseJSON . withoutStamps (channelStamps YieldRepresentationRemoved)
decodePayload YieldCreate = parseEither parseJSON . withoutStamps (channelStamps YieldCreate)
decodePayload YieldClonePersist = parseEither parseJSON . withoutStamps (channelStamps YieldClonePersist)
decodePayload YieldUpdate = parseEither parseJSON . withoutStamps (channelStamps YieldUpdate)
decodePayload YieldClone = parseEither parseJSON . withoutStamps (channelStamps YieldClone)
decodePayload YieldCloneTokenRequested = parseEither parseJSON . withoutStamps (channelStamps YieldCloneTokenRequested)
decodePayload YieldCloneResourceRequested = parseEither parseJSON . withoutStamps (channelStamps YieldCloneResourceRequested)
decodePayload YieldCloneCreate = parseEither parseJSON . withoutStamps (channelStamps YieldCloneCreate)
decodePayload YieldCreateOk = parseEither parseJSON . withoutStamps (channelStamps YieldCreateOk)
decodePayload YieldCreateFailed = parseEither parseJSON . withoutStamps (channelStamps YieldCreateFailed)
decodePayload YieldClonePersistOk = parseEither parseJSON . withoutStamps (channelStamps YieldClonePersistOk)
decodePayload YieldClonePersistFailed = parseEither parseJSON . withoutStamps (channelStamps YieldClonePersistFailed)
decodePayload YieldUpdateOk = parseEither parseJSON . withoutStamps (channelStamps YieldUpdateOk)
decodePayload YieldUpdateFailed = parseEither parseJSON . withoutStamps (channelStamps YieldUpdateFailed)
decodePayload YieldCloneTokenGenerated = parseEither parseJSON . withoutStamps (channelStamps YieldCloneTokenGenerated)
decodePayload YieldCloneTokenFailed = parseEither parseJSON . withoutStamps (channelStamps YieldCloneTokenFailed)
decodePayload YieldCloneResourceResult = parseEither parseJSON . withoutStamps (channelStamps YieldCloneResourceResult)
decodePayload YieldCloneResourceFailed = parseEither parseJSON . withoutStamps (channelStamps YieldCloneResourceFailed)
decodePayload YieldCloneCreated = parseEither parseJSON . withoutStamps (channelStamps YieldCloneCreated)
decodePayload YieldCloneCreateFailed = parseEither parseJSON . withoutStamps (channelStamps YieldCloneCreateFailed)
decodePayload MarkAdded = parseEither parseJSON . withoutStamps (channelStamps MarkAdded)
decodePayload MarkRemoved = parseEither parseJSON . withoutStamps (channelStamps MarkRemoved)
decodePayload MarkBodyUpdated = parseEither parseJSON . withoutStamps (channelStamps MarkBodyUpdated)
decodePayload MarkEntityTagAdded = parseEither parseJSON . withoutStamps (channelStamps MarkEntityTagAdded)
decodePayload MarkEntityTagRemoved = parseEither parseJSON . withoutStamps (channelStamps MarkEntityTagRemoved)
decodePayload MarkArchived = parseEither parseJSON . withoutStamps (channelStamps MarkArchived)
decodePayload MarkUnarchived = parseEither parseJSON . withoutStamps (channelStamps MarkUnarchived)
decodePayload MarkCreateRequest = parseEither parseJSON . withoutStamps (channelStamps MarkCreateRequest)
decodePayload MarkDelete = parseEither parseJSON . withoutStamps (channelStamps MarkDelete)
decodePayload MarkUpdateBody = parseEither parseJSON . withoutStamps (channelStamps MarkUpdateBody)
decodePayload MarkArchive = parseEither parseJSON . withoutStamps (channelStamps MarkArchive)
decodePayload MarkUnarchive = parseEither parseJSON . withoutStamps (channelStamps MarkUnarchive)
decodePayload MarkUpdateEntityTypes = parseEither parseJSON . withoutStamps (channelStamps MarkUpdateEntityTypes)
decodePayload MarkCreateOk = parseEither parseJSON . withoutStamps (channelStamps MarkCreateOk)
decodePayload MarkCreateFailed = parseEither parseJSON . withoutStamps (channelStamps MarkCreateFailed)
decodePayload MarkCommit = parseEither parseJSON . withoutStamps (channelStamps MarkCommit)
decodePayload MarkCommitOk = parseEither parseJSON . withoutStamps (channelStamps MarkCommitOk)
decodePayload MarkCommitFailed = parseEither parseJSON . withoutStamps (channelStamps MarkCommitFailed)
decodePayload MarkDeleteOk = parseEither parseJSON . withoutStamps (channelStamps MarkDeleteOk)
decodePayload MarkDeleteFailed = parseEither parseJSON . withoutStamps (channelStamps MarkDeleteFailed)
decodePayload MarkArchiveOk = parseEither parseJSON . withoutStamps (channelStamps MarkArchiveOk)
decodePayload MarkArchiveFailed = parseEither parseJSON . withoutStamps (channelStamps MarkArchiveFailed)
decodePayload MarkUnarchiveOk = parseEither parseJSON . withoutStamps (channelStamps MarkUnarchiveOk)
decodePayload MarkUnarchiveFailed = parseEither parseJSON . withoutStamps (channelStamps MarkUnarchiveFailed)
decodePayload MarkUpdateEntityTypesOk = parseEither parseJSON . withoutStamps (channelStamps MarkUpdateEntityTypesOk)
decodePayload MarkUpdateEntityTypesFailed = parseEither parseJSON . withoutStamps (channelStamps MarkUpdateEntityTypesFailed)
decodePayload MarkBodyUpdateFailed = parseEither parseJSON . withoutStamps (channelStamps MarkBodyUpdateFailed)
decodePayload MarkRequested = parseEither parseJSON . withoutStamps (channelStamps MarkRequested)
decodePayload MarkSubmit = parseEither parseJSON . withoutStamps (channelStamps MarkSubmit)
decodePayload MarkDelegateTimeout = parseEither parseJSON . withoutStamps (channelStamps MarkDelegateTimeout)
decodePayload MarkCreateError = parseEither parseJSON . withoutStamps (channelStamps MarkCreateError)
decodePayload MarkDeleteError = parseEither parseJSON . withoutStamps (channelStamps MarkDeleteError)
decodePayload BindBodyError = parseEither parseJSON . withoutStamps (channelStamps BindBodyError)
decodePayload FrameEntityTypeAdded = parseEither parseJSON . withoutStamps (channelStamps FrameEntityTypeAdded)
decodePayload FrameTagSchemaAdded = parseEither parseJSON . withoutStamps (channelStamps FrameTagSchemaAdded)
decodePayload FrameAddEntityType = parseEither parseJSON . withoutStamps (channelStamps FrameAddEntityType)
decodePayload FrameAddTagSchema = parseEither parseJSON . withoutStamps (channelStamps FrameAddTagSchema)
decodePayload FrameEntityTypeAddOk = parseEither parseJSON . withoutStamps (channelStamps FrameEntityTypeAddOk)
decodePayload FrameEntityTypeAddFailed = parseEither parseJSON . withoutStamps (channelStamps FrameEntityTypeAddFailed)
decodePayload FrameTagSchemaAddOk = parseEither parseJSON . withoutStamps (channelStamps FrameTagSchemaAddOk)
decodePayload FrameTagSchemaAddFailed = parseEither parseJSON . withoutStamps (channelStamps FrameTagSchemaAddFailed)
decodePayload PrincipalProfiled = parseEither parseJSON . withoutStamps (channelStamps PrincipalProfiled)
decodePayload PrincipalProfile = parseEither parseJSON . withoutStamps (channelStamps PrincipalProfile)
decodePayload BindInitiate = parseEither parseJSON . withoutStamps (channelStamps BindInitiate)
decodePayload BindUpdateBody = parseEither parseJSON . withoutStamps (channelStamps BindUpdateBody)
decodePayload BindBodyUpdated = parseEither parseJSON . withoutStamps (channelStamps BindBodyUpdated)
decodePayload BindBodyUpdateFailed = parseEither parseJSON . withoutStamps (channelStamps BindBodyUpdateFailed)
decodePayload MatchSearchRequested = parseEither parseJSON . withoutStamps (channelStamps MatchSearchRequested)
decodePayload MatchSearchResults = parseEither parseJSON . withoutStamps (channelStamps MatchSearchResults)
decodePayload MatchSearchFailed = parseEither parseJSON . withoutStamps (channelStamps MatchSearchFailed)
decodePayload MatchResourcesRequested = parseEither parseJSON . withoutStamps (channelStamps MatchResourcesRequested)
decodePayload MatchResourcesResult = parseEither parseJSON . withoutStamps (channelStamps MatchResourcesResult)
decodePayload MatchResourcesFailed = parseEither parseJSON . withoutStamps (channelStamps MatchResourcesFailed)
decodePayload MatchLimitsRequested = parseEither parseJSON . withoutStamps (channelStamps MatchLimitsRequested)
decodePayload MatchLimitsResult = parseEither parseJSON . withoutStamps (channelStamps MatchLimitsResult)
decodePayload MatchLimitsFailed = parseEither parseJSON . withoutStamps (channelStamps MatchLimitsFailed)
decodePayload GatherRequested = parseEither parseJSON . withoutStamps (channelStamps GatherRequested)
decodePayload GatherComplete = parseEither parseJSON . withoutStamps (channelStamps GatherComplete)
decodePayload GatherFailed = parseEither parseJSON . withoutStamps (channelStamps GatherFailed)
decodePayload GatherResourceRequested = parseEither parseJSON . withoutStamps (channelStamps GatherResourceRequested)
decodePayload GatherResourceComplete = parseEither parseJSON . withoutStamps (channelStamps GatherResourceComplete)
decodePayload GatherResourceFailed = parseEither parseJSON . withoutStamps (channelStamps GatherResourceFailed)
decodePayload GatherSummaryRequested = parseEither parseJSON . withoutStamps (channelStamps GatherSummaryRequested)
decodePayload GatherSummaryResult = parseEither parseJSON . withoutStamps (channelStamps GatherSummaryResult)
decodePayload GatherSummaryFailed = parseEither parseJSON . withoutStamps (channelStamps GatherSummaryFailed)
decodePayload GatherReferencedByRequested = parseEither parseJSON . withoutStamps (channelStamps GatherReferencedByRequested)
decodePayload GatherReferencedByResult = parseEither parseJSON . withoutStamps (channelStamps GatherReferencedByResult)
decodePayload GatherReferencedByFailed = parseEither parseJSON . withoutStamps (channelStamps GatherReferencedByFailed)
decodePayload GatherLimitsRequested = parseEither parseJSON . withoutStamps (channelStamps GatherLimitsRequested)
decodePayload GatherLimitsResult = parseEither parseJSON . withoutStamps (channelStamps GatherLimitsResult)
decodePayload GatherLimitsFailed = parseEither parseJSON . withoutStamps (channelStamps GatherLimitsFailed)
decodePayload BrowseResourceRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseResourceRequested)
decodePayload BrowseResourceResult = parseEither parseJSON . withoutStamps (channelStamps BrowseResourceResult)
decodePayload BrowseResourceFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseResourceFailed)
decodePayload BrowseResourcesRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseResourcesRequested)
decodePayload BrowseResourcesResult = parseEither parseJSON . withoutStamps (channelStamps BrowseResourcesResult)
decodePayload BrowseResourcesFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseResourcesFailed)
decodePayload BrowseAnnotationRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseAnnotationRequested)
decodePayload BrowseAnnotationResult = parseEither parseJSON . withoutStamps (channelStamps BrowseAnnotationResult)
decodePayload BrowseAnnotationFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseAnnotationFailed)
decodePayload BrowseEventsRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseEventsRequested)
decodePayload BrowseEventsResult = parseEither parseJSON . withoutStamps (channelStamps BrowseEventsResult)
decodePayload BrowseEventsFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseEventsFailed)
decodePayload BrowseAnnotationHistoryRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseAnnotationHistoryRequested)
decodePayload BrowseAnnotationHistoryResult = parseEither parseJSON . withoutStamps (channelStamps BrowseAnnotationHistoryResult)
decodePayload BrowseAnnotationHistoryFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseAnnotationHistoryFailed)
decodePayload BrowseEntityTypesRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseEntityTypesRequested)
decodePayload BrowseEntityTypesResult = parseEither parseJSON . withoutStamps (channelStamps BrowseEntityTypesResult)
decodePayload BrowseEntityTypesFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseEntityTypesFailed)
decodePayload BrowseTagSchemasRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseTagSchemasRequested)
decodePayload BrowseTagSchemasResult = parseEither parseJSON . withoutStamps (channelStamps BrowseTagSchemasResult)
decodePayload BrowseTagSchemasFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseTagSchemasFailed)
decodePayload BrowseEnginesRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseEnginesRequested)
decodePayload BrowseEnginesResult = parseEither parseJSON . withoutStamps (channelStamps BrowseEnginesResult)
decodePayload BrowseEnginesFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseEnginesFailed)
decodePayload BrowseProfilesRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseProfilesRequested)
decodePayload BrowseProfilesResult = parseEither parseJSON . withoutStamps (channelStamps BrowseProfilesResult)
decodePayload BrowseProfilesFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseProfilesFailed)
decodePayload BrowseKbRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseKbRequested)
decodePayload BrowseKbResult = parseEither parseJSON . withoutStamps (channelStamps BrowseKbResult)
decodePayload BrowseKbFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseKbFailed)
decodePayload BrowseDirectoryRequested = parseEither parseJSON . withoutStamps (channelStamps BrowseDirectoryRequested)
decodePayload BrowseDirectoryResult = parseEither parseJSON . withoutStamps (channelStamps BrowseDirectoryResult)
decodePayload BrowseDirectoryFailed = parseEither parseJSON . withoutStamps (channelStamps BrowseDirectoryFailed)
decodePayload BrowseClick = parseEither parseJSON . withoutStamps (channelStamps BrowseClick)
decodePayload BrowseResourceOpen = parseEither parseJSON . withoutStamps (channelStamps BrowseResourceOpen)
decodePayload BrowseResourceViewed = parseEither parseJSON . withoutStamps (channelStamps BrowseResourceViewed)
decodePayload BrowseEntityTypeClicked = parseEither parseJSON . withoutStamps (channelStamps BrowseEntityTypeClicked)
decodePayload PanelToggle = parseEither parseJSON . withoutStamps (channelStamps PanelToggle)
decodePayload PanelOpen = parseEither parseJSON . withoutStamps (channelStamps PanelOpen)
decodePayload PanelClose = parseEither parseJSON . withoutStamps (channelStamps PanelClose)
decodePayload ShellSidebarToggle = parseEither parseJSON . withoutStamps (channelStamps ShellSidebarToggle)
decodePayload TabsClose = parseEither parseJSON . withoutStamps (channelStamps TabsClose)
decodePayload TabsReorder = parseEither parseJSON . withoutStamps (channelStamps TabsReorder)
decodePayload NavLinkClicked = parseEither parseJSON . withoutStamps (channelStamps NavLinkClicked)
decodePayload NavPush = parseEither parseJSON . withoutStamps (channelStamps NavPush)
decodePayload NavExternal = parseEither parseJSON . withoutStamps (channelStamps NavExternal)
decodePayload BeckonHover = parseEither parseJSON . withoutStamps (channelStamps BeckonHover)
decodePayload BeckonFocus = parseEither parseJSON . withoutStamps (channelStamps BeckonFocus)
decodePayload BeckonSparkle = parseEither parseJSON . withoutStamps (channelStamps BeckonSparkle)
decodePayload JobStarted = parseEither parseJSON . withoutStamps (channelStamps JobStarted)
decodePayload JobAssigned = parseEither parseJSON . withoutStamps (channelStamps JobAssigned)
decodePayload JobCompleted = parseEither parseJSON . withoutStamps (channelStamps JobCompleted)
decodePayload JobFailed = parseEither parseJSON . withoutStamps (channelStamps JobFailed)
decodePayload JobStart = parseEither parseJSON . withoutStamps (channelStamps JobStart)
decodePayload JobAssign = parseEither parseJSON . withoutStamps (channelStamps JobAssign)
decodePayload JobReportProgress = parseEither parseJSON . withoutStamps (channelStamps JobReportProgress)
decodePayload JobComplete = parseEither parseJSON . withoutStamps (channelStamps JobComplete)
decodePayload JobFail = parseEither parseJSON . withoutStamps (channelStamps JobFail)
decodePayload JobCheckpoint = parseEither parseJSON . withoutStamps (channelStamps JobCheckpoint)
decodePayload JobQueued = parseEither parseJSON . withoutStamps (channelStamps JobQueued)
decodePayload JobCancelRequested = parseEither parseJSON . withoutStamps (channelStamps JobCancelRequested)
decodePayload JobCancel = parseEither parseJSON . withoutStamps (channelStamps JobCancel)
decodePayload JobLimitsRequested = parseEither parseJSON . withoutStamps (channelStamps JobLimitsRequested)
decodePayload JobLimitsResult = parseEither parseJSON . withoutStamps (channelStamps JobLimitsResult)
decodePayload JobLimitsFailed = parseEither parseJSON . withoutStamps (channelStamps JobLimitsFailed)
decodePayload JobStatusRequested = parseEither parseJSON . withoutStamps (channelStamps JobStatusRequested)
decodePayload JobCreate = parseEither parseJSON . withoutStamps (channelStamps JobCreate)
decodePayload JobClaim = parseEither parseJSON . withoutStamps (channelStamps JobClaim)
decodePayload JobStatusResult = parseEither parseJSON . withoutStamps (channelStamps JobStatusResult)
decodePayload JobStatusFailed = parseEither parseJSON . withoutStamps (channelStamps JobStatusFailed)
decodePayload JobCreated = parseEither parseJSON . withoutStamps (channelStamps JobCreated)
decodePayload JobCreateFailed = parseEither parseJSON . withoutStamps (channelStamps JobCreateFailed)
decodePayload JobClaimed = parseEither parseJSON . withoutStamps (channelStamps JobClaimed)
decodePayload JobClaimFailed = parseEither parseJSON . withoutStamps (channelStamps JobClaimFailed)
decodePayload JobCancelOk = parseEither parseJSON . withoutStamps (channelStamps JobCancelOk)
decodePayload JobCancelFailed = parseEither parseJSON . withoutStamps (channelStamps JobCancelFailed)
decodePayload WeaveApplied = parseEither parseJSON . withoutStamps (channelStamps WeaveApplied)
decodePayload SmeltSettled = parseEither parseJSON . withoutStamps (channelStamps SmeltSettled)
decodePayload WeaveRebuild = parseEither parseJSON . withoutStamps (channelStamps WeaveRebuild)
decodePayload WeaveRebuildOk = parseEither parseJSON . withoutStamps (channelStamps WeaveRebuildOk)
decodePayload WeaveRebuildFailed = parseEither parseJSON . withoutStamps (channelStamps WeaveRebuildFailed)
decodePayload SmeltRebuildAnchors = parseEither parseJSON . withoutStamps (channelStamps SmeltRebuildAnchors)
decodePayload SmeltRebuildAnchorsOk = parseEither parseJSON . withoutStamps (channelStamps SmeltRebuildAnchorsOk)
decodePayload SmeltRebuildAnchorsFailed = parseEither parseJSON . withoutStamps (channelStamps SmeltRebuildAnchorsFailed)
decodePayload SettingsThemeChanged = parseEither parseJSON . withoutStamps (channelStamps SettingsThemeChanged)
decodePayload SettingsLineNumbersToggled = parseEither parseJSON . withoutStamps (channelStamps SettingsLineNumbersToggled)
decodePayload SettingsLocaleChanged = parseEither parseJSON . withoutStamps (channelStamps SettingsLocaleChanged)
decodePayload SettingsHoverDelayChanged = parseEither parseJSON . withoutStamps (channelStamps SettingsHoverDelayChanged)
decodePayload BusResumeGap = parseEither parseJSON . withoutStamps (channelStamps BusResumeGap)
decodePayload SessionJoined = parseEither parseJSON . withoutStamps (channelStamps SessionJoined)
decodePayload SessionLeft = parseEither parseJSON . withoutStamps (channelStamps SessionLeft)
channelStamps :: Channel scope payload -> [Text]
channelStamps YieldCreated = []
channelStamps YieldCloned = []
channelStamps YieldUpdated = []
channelStamps YieldMoved = []
channelStamps YieldRepresentationAdded = []
channelStamps YieldRepresentationRemoved = []
channelStamps YieldCreate = ["_roles", "_userId"]
channelStamps YieldClonePersist = ["_userId"]
channelStamps YieldUpdate = ["_userId"]
channelStamps YieldClone = []
channelStamps YieldCloneTokenRequested = []
channelStamps YieldCloneResourceRequested = []
channelStamps YieldCloneCreate = ["_userId"]
channelStamps YieldCreateOk = []
channelStamps YieldCreateFailed = []
channelStamps YieldClonePersistOk = []
channelStamps YieldClonePersistFailed = []
channelStamps YieldUpdateOk = []
channelStamps YieldUpdateFailed = []
channelStamps YieldCloneTokenGenerated = []
channelStamps YieldCloneTokenFailed = []
channelStamps YieldCloneResourceResult = []
channelStamps YieldCloneResourceFailed = []
channelStamps YieldCloneCreated = []
channelStamps YieldCloneCreateFailed = []
channelStamps MarkAdded = []
channelStamps MarkRemoved = []
channelStamps MarkBodyUpdated = []
channelStamps MarkEntityTagAdded = []
channelStamps MarkEntityTagRemoved = []
channelStamps MarkArchived = []
channelStamps MarkUnarchived = []
channelStamps MarkCreateRequest = []
channelStamps MarkDelete = ["_userId"]
channelStamps MarkUpdateBody = ["_userId"]
channelStamps MarkArchive = ["_userId"]
channelStamps MarkUnarchive = ["_userId"]
channelStamps MarkUpdateEntityTypes = ["_userId"]
channelStamps MarkCreateOk = []
channelStamps MarkCreateFailed = []
channelStamps MarkCommit = ["_roles", "_userId"]
channelStamps MarkCommitOk = []
channelStamps MarkCommitFailed = []
channelStamps MarkDeleteOk = []
channelStamps MarkDeleteFailed = []
channelStamps MarkArchiveOk = []
channelStamps MarkArchiveFailed = []
channelStamps MarkUnarchiveOk = []
channelStamps MarkUnarchiveFailed = []
channelStamps MarkUpdateEntityTypesOk = []
channelStamps MarkUpdateEntityTypesFailed = []
channelStamps MarkBodyUpdateFailed = []
channelStamps MarkRequested = []
channelStamps MarkSubmit = []
channelStamps MarkDelegateTimeout = []
channelStamps MarkCreateError = []
channelStamps MarkDeleteError = []
channelStamps BindBodyError = []
channelStamps FrameEntityTypeAdded = []
channelStamps FrameTagSchemaAdded = []
channelStamps FrameAddEntityType = ["_userId"]
channelStamps FrameAddTagSchema = ["_userId"]
channelStamps FrameEntityTypeAddOk = []
channelStamps FrameEntityTypeAddFailed = []
channelStamps FrameTagSchemaAddOk = []
channelStamps FrameTagSchemaAddFailed = []
channelStamps PrincipalProfiled = []
channelStamps PrincipalProfile = ["_userId"]
channelStamps BindInitiate = []
channelStamps BindUpdateBody = ["_userId"]
channelStamps BindBodyUpdated = []
channelStamps BindBodyUpdateFailed = []
channelStamps MatchSearchRequested = []
channelStamps MatchSearchResults = []
channelStamps MatchSearchFailed = []
channelStamps MatchResourcesRequested = []
channelStamps MatchResourcesResult = []
channelStamps MatchResourcesFailed = []
channelStamps MatchLimitsRequested = []
channelStamps MatchLimitsResult = []
channelStamps MatchLimitsFailed = []
channelStamps GatherRequested = []
channelStamps GatherComplete = []
channelStamps GatherFailed = []
channelStamps GatherResourceRequested = []
channelStamps GatherResourceComplete = []
channelStamps GatherResourceFailed = []
channelStamps GatherSummaryRequested = []
channelStamps GatherSummaryResult = []
channelStamps GatherSummaryFailed = []
channelStamps GatherReferencedByRequested = []
channelStamps GatherReferencedByResult = []
channelStamps GatherReferencedByFailed = []
channelStamps GatherLimitsRequested = []
channelStamps GatherLimitsResult = []
channelStamps GatherLimitsFailed = []
channelStamps BrowseResourceRequested = []
channelStamps BrowseResourceResult = []
channelStamps BrowseResourceFailed = []
channelStamps BrowseResourcesRequested = []
channelStamps BrowseResourcesResult = []
channelStamps BrowseResourcesFailed = []
channelStamps BrowseAnnotationRequested = []
channelStamps BrowseAnnotationResult = []
channelStamps BrowseAnnotationFailed = []
channelStamps BrowseEventsRequested = []
channelStamps BrowseEventsResult = []
channelStamps BrowseEventsFailed = []
channelStamps BrowseAnnotationHistoryRequested = []
channelStamps BrowseAnnotationHistoryResult = []
channelStamps BrowseAnnotationHistoryFailed = []
channelStamps BrowseEntityTypesRequested = []
channelStamps BrowseEntityTypesResult = []
channelStamps BrowseEntityTypesFailed = []
channelStamps BrowseTagSchemasRequested = []
channelStamps BrowseTagSchemasResult = []
channelStamps BrowseTagSchemasFailed = []
channelStamps BrowseEnginesRequested = []
channelStamps BrowseEnginesResult = []
channelStamps BrowseEnginesFailed = []
channelStamps BrowseProfilesRequested = []
channelStamps BrowseProfilesResult = []
channelStamps BrowseProfilesFailed = []
channelStamps BrowseKbRequested = []
channelStamps BrowseKbResult = []
channelStamps BrowseKbFailed = []
channelStamps BrowseDirectoryRequested = []
channelStamps BrowseDirectoryResult = []
channelStamps BrowseDirectoryFailed = []
channelStamps BrowseClick = []
channelStamps BrowseResourceOpen = []
channelStamps BrowseResourceViewed = []
channelStamps BrowseEntityTypeClicked = []
channelStamps PanelToggle = []
channelStamps PanelOpen = []
channelStamps PanelClose = []
channelStamps ShellSidebarToggle = []
channelStamps TabsClose = []
channelStamps TabsReorder = []
channelStamps NavLinkClicked = []
channelStamps NavPush = []
channelStamps NavExternal = []
channelStamps BeckonHover = []
channelStamps BeckonFocus = []
channelStamps BeckonSparkle = []
channelStamps JobStarted = []
channelStamps JobAssigned = []
channelStamps JobCompleted = []
channelStamps JobFailed = []
channelStamps JobStart = ["_userId"]
channelStamps JobAssign = ["_userId"]
channelStamps JobReportProgress = ["_userId"]
channelStamps JobComplete = []
channelStamps JobFail = ["_userId"]
channelStamps JobCheckpoint = ["_userId"]
channelStamps JobQueued = []
channelStamps JobCancelRequested = []
channelStamps JobCancel = ["_userId"]
channelStamps JobLimitsRequested = []
channelStamps JobLimitsResult = []
channelStamps JobLimitsFailed = []
channelStamps JobStatusRequested = []
channelStamps JobCreate = []
channelStamps JobClaim = ["_roles", "_userId"]
channelStamps JobStatusResult = []
channelStamps JobStatusFailed = []
channelStamps JobCreated = []
channelStamps JobCreateFailed = []
channelStamps JobClaimed = []
channelStamps JobClaimFailed = []
channelStamps JobCancelOk = []
channelStamps JobCancelFailed = []
channelStamps WeaveApplied = []
channelStamps SmeltSettled = []
channelStamps WeaveRebuild = ["_userId"]
channelStamps WeaveRebuildOk = []
channelStamps WeaveRebuildFailed = []
channelStamps SmeltRebuildAnchors = ["_userId"]
channelStamps SmeltRebuildAnchorsOk = []
channelStamps SmeltRebuildAnchorsFailed = []
channelStamps SettingsThemeChanged = []
channelStamps SettingsLineNumbersToggled = []
channelStamps SettingsLocaleChanged = []
channelStamps SettingsHoverDelayChanged = []
channelStamps BusResumeGap = []
channelStamps SessionJoined = []
channelStamps SessionLeft = []
withoutStamps :: [Text] -> Value -> Value
withoutStamps declared (Object fields) = Object (KM.filterWithKey (\key _ -> let name = Key.toText key in not (T.isPrefixOf "_" name) || name `elem` declared) fields)
withoutStamps _ value = value
data Operation input output failure where
  BindUpdateBodyOperation :: Operation Types.BindUpdateBodyCommand Types.BindBodyUpdated Types.CommandError
  BrowseResourceRequestedOperation :: Operation Types.BrowseResourceRequest Types.BrowseResourceResult Types.CommandError
  BrowseResourcesRequestedOperation :: Operation Types.BrowseResourcesRequest Types.BrowseResourcesResult Types.CommandError
  BrowseAnnotationRequestedOperation :: Operation Types.BrowseAnnotationRequest Types.BrowseAnnotationResult Types.CommandError
  BrowseAnnotationHistoryRequestedOperation :: Operation Types.BrowseAnnotationHistoryRequest Types.BrowseAnnotationHistoryResult Types.CommandError
  BrowseEventsRequestedOperation :: Operation Types.BrowseEventsRequest Types.BrowseEventsResult Types.CommandError
  BrowseEntityTypesRequestedOperation :: Operation Types.BrowseEntityTypesRequest Types.BrowseEntityTypesResult Types.CommandError
  BrowseTagSchemasRequestedOperation :: Operation Types.BrowseTagSchemasRequest Types.BrowseTagSchemasResult Types.CommandError
  BrowseEnginesRequestedOperation :: Operation Types.BrowseEnginesRequest Types.BrowseEnginesResult Types.CommandError
  BrowseProfilesRequestedOperation :: Operation Types.BrowseProfilesRequest Types.BrowseProfilesResult Types.CommandError
  BrowseKbRequestedOperation :: Operation Types.BrowseKbRequest Types.BrowseKbResult Types.CommandError
  BrowseDirectoryRequestedOperation :: Operation Types.BrowseDirectoryRequest Types.BrowseDirectoryResult Types.BrowseDirectoryFailed
  FrameAddEntityTypeOperation :: Operation Types.FrameAddEntityTypeCommand Types.EmptyBusPayload Types.CommandError
  FrameAddTagSchemaOperation :: Operation Types.FrameAddTagSchemaCommand Types.EmptyBusPayload Types.CommandError
  GatherRequestedOperation :: Operation Types.GatherAnnotationRequest Types.GatherAnnotationComplete Types.GatherFailed
  GatherResourceRequestedOperation :: Operation Types.GatherResourceRequest Types.GatherResourceComplete Types.GatherResourceFailed
  GatherSummaryRequestedOperation :: Operation Types.GatherSummaryRequest Types.ContextualSummaryResponseBusEnvelope Types.CommandError
  GatherReferencedByRequestedOperation :: Operation Types.GatherReferencedByRequest Types.GatherReferencedByResult Types.CommandError
  GatherLimitsRequestedOperation :: Operation Types.InferenceLimitsRequest Types.InferenceLimitsResult Types.CommandError
  JobCreateOperation :: Operation Types.JobCreateCommand Types.JobCreatedResult Types.CommandError
  JobStatusRequestedOperation :: Operation Types.JobStatusRequest Types.JobStatusResult Types.CommandError
  JobLimitsRequestedOperation :: Operation Types.InferenceLimitsRequest Types.InferenceLimitsResult Types.CommandError
  JobCancelRequestedOperation :: Operation Types.JobCancelRequest Types.JobCancelResultBusEnvelope Types.CommandError
  JobClaimOperation :: Operation Types.JobClaimCommand Types.JobClaimedResult Types.CommandError
  MarkCreateRequestOperation :: Operation Types.MarkCreateRequest Types.MarkCreateOk Types.CommandError
  MarkCommitOperation :: Operation Types.MarkCommitCommand Types.MarkCommitOk Types.CommandError
  MarkDeleteOperation :: Operation Types.MarkDeleteCommand Types.MarkDeleteOk Types.CommandError
  MarkArchiveOperation :: Operation Types.MarkArchiveCommand Types.EmptyBusPayload Types.CommandError
  MarkUnarchiveOperation :: Operation Types.MarkUnarchiveCommand Types.EmptyBusPayload Types.CommandError
  MarkUpdateEntityTypesOperation :: Operation Types.MarkUpdateEntityTypesCommand Types.EmptyBusPayload Types.CommandError
  MatchSearchRequestedOperation :: Operation Types.MatchSearchRequest Types.MatchSearchResult Types.MatchSearchFailed
  MatchResourcesRequestedOperation :: Operation Types.MatchResourcesRequest Types.MatchResourcesResult Types.CommandError
  MatchLimitsRequestedOperation :: Operation Types.InferenceLimitsRequest Types.InferenceLimitsResult Types.CommandError
  WeaveRebuildOperation :: Operation Types.WeaveRebuildCommand Types.EmptyBusPayload Types.CommandError
  SmeltRebuildAnchorsOperation :: Operation Types.SmeltRebuildAnchorsCommand Types.EmptyBusPayload Types.CommandError
  YieldCreateOperation :: Operation Types.YieldCreateCommand Types.YieldCreateOk Types.CommandError
  YieldClonePersistOperation :: Operation Types.YieldClonePersistCommand Types.YieldClonePersistOk Types.CommandError
  YieldUpdateOperation :: Operation Types.YieldUpdateCommand Types.YieldUpdateOk Types.CommandError
  YieldCloneCreateOperation :: Operation Types.YieldCloneCreateCommand Types.YieldCloneCreated Types.CommandError
  YieldCloneResourceRequestedOperation :: Operation Types.YieldCloneResourceRequest Types.GetResourceByTokenResponseBusEnvelope Types.CommandError
  YieldCloneTokenRequestedOperation :: Operation Types.YieldCloneTokenRequest Types.CloneResourceWithTokenResponseBusEnvelope Types.CommandError
data SomeOperation where
  SomeOperation :: Operation input output failure -> SomeOperation
allOperations :: [SomeOperation]
allOperations = [SomeOperation BindUpdateBodyOperation, SomeOperation BrowseResourceRequestedOperation, SomeOperation BrowseResourcesRequestedOperation, SomeOperation BrowseAnnotationRequestedOperation, SomeOperation BrowseAnnotationHistoryRequestedOperation, SomeOperation BrowseEventsRequestedOperation, SomeOperation BrowseEntityTypesRequestedOperation, SomeOperation BrowseTagSchemasRequestedOperation, SomeOperation BrowseEnginesRequestedOperation, SomeOperation BrowseProfilesRequestedOperation, SomeOperation BrowseKbRequestedOperation, SomeOperation BrowseDirectoryRequestedOperation, SomeOperation FrameAddEntityTypeOperation, SomeOperation FrameAddTagSchemaOperation, SomeOperation GatherRequestedOperation, SomeOperation GatherResourceRequestedOperation, SomeOperation GatherSummaryRequestedOperation, SomeOperation GatherReferencedByRequestedOperation, SomeOperation GatherLimitsRequestedOperation, SomeOperation JobCreateOperation, SomeOperation JobStatusRequestedOperation, SomeOperation JobLimitsRequestedOperation, SomeOperation JobCancelRequestedOperation, SomeOperation JobClaimOperation, SomeOperation MarkCreateRequestOperation, SomeOperation MarkCommitOperation, SomeOperation MarkDeleteOperation, SomeOperation MarkArchiveOperation, SomeOperation MarkUnarchiveOperation, SomeOperation MarkUpdateEntityTypesOperation, SomeOperation MatchSearchRequestedOperation, SomeOperation MatchResourcesRequestedOperation, SomeOperation MatchLimitsRequestedOperation, SomeOperation WeaveRebuildOperation, SomeOperation SmeltRebuildAnchorsOperation, SomeOperation YieldCreateOperation, SomeOperation YieldClonePersistOperation, SomeOperation YieldUpdateOperation, SomeOperation YieldCloneCreateOperation, SomeOperation YieldCloneResourceRequestedOperation, SomeOperation YieldCloneTokenRequestedOperation]
operationChannels :: Operation input output failure -> (Channel 'Global input, Channel 'Global output, Channel 'Global failure)
operationChannels BindUpdateBodyOperation = (BindUpdateBody, BindBodyUpdated, BindBodyUpdateFailed)
operationChannels BrowseResourceRequestedOperation = (BrowseResourceRequested, BrowseResourceResult, BrowseResourceFailed)
operationChannels BrowseResourcesRequestedOperation = (BrowseResourcesRequested, BrowseResourcesResult, BrowseResourcesFailed)
operationChannels BrowseAnnotationRequestedOperation = (BrowseAnnotationRequested, BrowseAnnotationResult, BrowseAnnotationFailed)
operationChannels BrowseAnnotationHistoryRequestedOperation = (BrowseAnnotationHistoryRequested, BrowseAnnotationHistoryResult, BrowseAnnotationHistoryFailed)
operationChannels BrowseEventsRequestedOperation = (BrowseEventsRequested, BrowseEventsResult, BrowseEventsFailed)
operationChannels BrowseEntityTypesRequestedOperation = (BrowseEntityTypesRequested, BrowseEntityTypesResult, BrowseEntityTypesFailed)
operationChannels BrowseTagSchemasRequestedOperation = (BrowseTagSchemasRequested, BrowseTagSchemasResult, BrowseTagSchemasFailed)
operationChannels BrowseEnginesRequestedOperation = (BrowseEnginesRequested, BrowseEnginesResult, BrowseEnginesFailed)
operationChannels BrowseProfilesRequestedOperation = (BrowseProfilesRequested, BrowseProfilesResult, BrowseProfilesFailed)
operationChannels BrowseKbRequestedOperation = (BrowseKbRequested, BrowseKbResult, BrowseKbFailed)
operationChannels BrowseDirectoryRequestedOperation = (BrowseDirectoryRequested, BrowseDirectoryResult, BrowseDirectoryFailed)
operationChannels FrameAddEntityTypeOperation = (FrameAddEntityType, FrameEntityTypeAddOk, FrameEntityTypeAddFailed)
operationChannels FrameAddTagSchemaOperation = (FrameAddTagSchema, FrameTagSchemaAddOk, FrameTagSchemaAddFailed)
operationChannels GatherRequestedOperation = (GatherRequested, GatherComplete, GatherFailed)
operationChannels GatherResourceRequestedOperation = (GatherResourceRequested, GatherResourceComplete, GatherResourceFailed)
operationChannels GatherSummaryRequestedOperation = (GatherSummaryRequested, GatherSummaryResult, GatherSummaryFailed)
operationChannels GatherReferencedByRequestedOperation = (GatherReferencedByRequested, GatherReferencedByResult, GatherReferencedByFailed)
operationChannels GatherLimitsRequestedOperation = (GatherLimitsRequested, GatherLimitsResult, GatherLimitsFailed)
operationChannels JobCreateOperation = (JobCreate, JobCreated, JobCreateFailed)
operationChannels JobStatusRequestedOperation = (JobStatusRequested, JobStatusResult, JobStatusFailed)
operationChannels JobLimitsRequestedOperation = (JobLimitsRequested, JobLimitsResult, JobLimitsFailed)
operationChannels JobCancelRequestedOperation = (JobCancelRequested, JobCancelOk, JobCancelFailed)
operationChannels JobClaimOperation = (JobClaim, JobClaimed, JobClaimFailed)
operationChannels MarkCreateRequestOperation = (MarkCreateRequest, MarkCreateOk, MarkCreateFailed)
operationChannels MarkCommitOperation = (MarkCommit, MarkCommitOk, MarkCommitFailed)
operationChannels MarkDeleteOperation = (MarkDelete, MarkDeleteOk, MarkDeleteFailed)
operationChannels MarkArchiveOperation = (MarkArchive, MarkArchiveOk, MarkArchiveFailed)
operationChannels MarkUnarchiveOperation = (MarkUnarchive, MarkUnarchiveOk, MarkUnarchiveFailed)
operationChannels MarkUpdateEntityTypesOperation = (MarkUpdateEntityTypes, MarkUpdateEntityTypesOk, MarkUpdateEntityTypesFailed)
operationChannels MatchSearchRequestedOperation = (MatchSearchRequested, MatchSearchResults, MatchSearchFailed)
operationChannels MatchResourcesRequestedOperation = (MatchResourcesRequested, MatchResourcesResult, MatchResourcesFailed)
operationChannels MatchLimitsRequestedOperation = (MatchLimitsRequested, MatchLimitsResult, MatchLimitsFailed)
operationChannels WeaveRebuildOperation = (WeaveRebuild, WeaveRebuildOk, WeaveRebuildFailed)
operationChannels SmeltRebuildAnchorsOperation = (SmeltRebuildAnchors, SmeltRebuildAnchorsOk, SmeltRebuildAnchorsFailed)
operationChannels YieldCreateOperation = (YieldCreate, YieldCreateOk, YieldCreateFailed)
operationChannels YieldClonePersistOperation = (YieldClonePersist, YieldClonePersistOk, YieldClonePersistFailed)
operationChannels YieldUpdateOperation = (YieldUpdate, YieldUpdateOk, YieldUpdateFailed)
operationChannels YieldCloneCreateOperation = (YieldCloneCreate, YieldCloneCreated, YieldCloneCreateFailed)
operationChannels YieldCloneResourceRequestedOperation = (YieldCloneResourceRequested, YieldCloneResourceResult, YieldCloneResourceFailed)
operationChannels YieldCloneTokenRequestedOperation = (YieldCloneTokenRequested, YieldCloneTokenGenerated, YieldCloneTokenFailed)
