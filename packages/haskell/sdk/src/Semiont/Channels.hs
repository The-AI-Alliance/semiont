-- Generated from protocol/specs/src/bus/registry.json. Do not edit.
{-# LANGUAGE DataKinds, GADTs, KindSignatures, OverloadedStrings #-}
module Semiont.Channels (Scope(..), ScopeArg(..), Channel(..), Operation(..), channelName, channelIsScoped, encodePayload, decodePayload, operationChannels) where
import Data.Aeson (Value, toJSON, parseJSON)
import Data.Aeson.Types (parseEither)
import Data.Text (Text)
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
decodePayload YieldCreated = parseEither parseJSON
decodePayload YieldCloned = parseEither parseJSON
decodePayload YieldUpdated = parseEither parseJSON
decodePayload YieldMoved = parseEither parseJSON
decodePayload YieldRepresentationAdded = parseEither parseJSON
decodePayload YieldRepresentationRemoved = parseEither parseJSON
decodePayload YieldCreate = parseEither parseJSON
decodePayload YieldClonePersist = parseEither parseJSON
decodePayload YieldUpdate = parseEither parseJSON
decodePayload YieldClone = parseEither parseJSON
decodePayload YieldCloneTokenRequested = parseEither parseJSON
decodePayload YieldCloneResourceRequested = parseEither parseJSON
decodePayload YieldCloneCreate = parseEither parseJSON
decodePayload YieldCreateOk = parseEither parseJSON
decodePayload YieldCreateFailed = parseEither parseJSON
decodePayload YieldClonePersistOk = parseEither parseJSON
decodePayload YieldClonePersistFailed = parseEither parseJSON
decodePayload YieldUpdateOk = parseEither parseJSON
decodePayload YieldUpdateFailed = parseEither parseJSON
decodePayload YieldCloneTokenGenerated = parseEither parseJSON
decodePayload YieldCloneTokenFailed = parseEither parseJSON
decodePayload YieldCloneResourceResult = parseEither parseJSON
decodePayload YieldCloneResourceFailed = parseEither parseJSON
decodePayload YieldCloneCreated = parseEither parseJSON
decodePayload YieldCloneCreateFailed = parseEither parseJSON
decodePayload MarkAdded = parseEither parseJSON
decodePayload MarkRemoved = parseEither parseJSON
decodePayload MarkBodyUpdated = parseEither parseJSON
decodePayload MarkEntityTagAdded = parseEither parseJSON
decodePayload MarkEntityTagRemoved = parseEither parseJSON
decodePayload MarkArchived = parseEither parseJSON
decodePayload MarkUnarchived = parseEither parseJSON
decodePayload MarkCreateRequest = parseEither parseJSON
decodePayload MarkDelete = parseEither parseJSON
decodePayload MarkUpdateBody = parseEither parseJSON
decodePayload MarkArchive = parseEither parseJSON
decodePayload MarkUnarchive = parseEither parseJSON
decodePayload MarkUpdateEntityTypes = parseEither parseJSON
decodePayload MarkCreateOk = parseEither parseJSON
decodePayload MarkCreateFailed = parseEither parseJSON
decodePayload MarkCommit = parseEither parseJSON
decodePayload MarkCommitOk = parseEither parseJSON
decodePayload MarkCommitFailed = parseEither parseJSON
decodePayload MarkDeleteOk = parseEither parseJSON
decodePayload MarkDeleteFailed = parseEither parseJSON
decodePayload MarkArchiveOk = parseEither parseJSON
decodePayload MarkArchiveFailed = parseEither parseJSON
decodePayload MarkUnarchiveOk = parseEither parseJSON
decodePayload MarkUnarchiveFailed = parseEither parseJSON
decodePayload MarkUpdateEntityTypesOk = parseEither parseJSON
decodePayload MarkUpdateEntityTypesFailed = parseEither parseJSON
decodePayload MarkBodyUpdateFailed = parseEither parseJSON
decodePayload MarkRequested = parseEither parseJSON
decodePayload MarkSubmit = parseEither parseJSON
decodePayload MarkDelegateTimeout = parseEither parseJSON
decodePayload MarkCreateError = parseEither parseJSON
decodePayload MarkDeleteError = parseEither parseJSON
decodePayload BindBodyError = parseEither parseJSON
decodePayload FrameEntityTypeAdded = parseEither parseJSON
decodePayload FrameTagSchemaAdded = parseEither parseJSON
decodePayload FrameAddEntityType = parseEither parseJSON
decodePayload FrameAddTagSchema = parseEither parseJSON
decodePayload FrameEntityTypeAddOk = parseEither parseJSON
decodePayload FrameEntityTypeAddFailed = parseEither parseJSON
decodePayload FrameTagSchemaAddOk = parseEither parseJSON
decodePayload FrameTagSchemaAddFailed = parseEither parseJSON
decodePayload PrincipalProfiled = parseEither parseJSON
decodePayload PrincipalProfile = parseEither parseJSON
decodePayload BindInitiate = parseEither parseJSON
decodePayload BindUpdateBody = parseEither parseJSON
decodePayload BindBodyUpdated = parseEither parseJSON
decodePayload BindBodyUpdateFailed = parseEither parseJSON
decodePayload MatchSearchRequested = parseEither parseJSON
decodePayload MatchSearchResults = parseEither parseJSON
decodePayload MatchSearchFailed = parseEither parseJSON
decodePayload MatchResourcesRequested = parseEither parseJSON
decodePayload MatchResourcesResult = parseEither parseJSON
decodePayload MatchResourcesFailed = parseEither parseJSON
decodePayload MatchLimitsRequested = parseEither parseJSON
decodePayload MatchLimitsResult = parseEither parseJSON
decodePayload MatchLimitsFailed = parseEither parseJSON
decodePayload GatherRequested = parseEither parseJSON
decodePayload GatherComplete = parseEither parseJSON
decodePayload GatherFailed = parseEither parseJSON
decodePayload GatherResourceRequested = parseEither parseJSON
decodePayload GatherResourceComplete = parseEither parseJSON
decodePayload GatherResourceFailed = parseEither parseJSON
decodePayload GatherSummaryRequested = parseEither parseJSON
decodePayload GatherSummaryResult = parseEither parseJSON
decodePayload GatherSummaryFailed = parseEither parseJSON
decodePayload GatherReferencedByRequested = parseEither parseJSON
decodePayload GatherReferencedByResult = parseEither parseJSON
decodePayload GatherReferencedByFailed = parseEither parseJSON
decodePayload GatherLimitsRequested = parseEither parseJSON
decodePayload GatherLimitsResult = parseEither parseJSON
decodePayload GatherLimitsFailed = parseEither parseJSON
decodePayload BrowseResourceRequested = parseEither parseJSON
decodePayload BrowseResourceResult = parseEither parseJSON
decodePayload BrowseResourceFailed = parseEither parseJSON
decodePayload BrowseResourcesRequested = parseEither parseJSON
decodePayload BrowseResourcesResult = parseEither parseJSON
decodePayload BrowseResourcesFailed = parseEither parseJSON
decodePayload BrowseAnnotationRequested = parseEither parseJSON
decodePayload BrowseAnnotationResult = parseEither parseJSON
decodePayload BrowseAnnotationFailed = parseEither parseJSON
decodePayload BrowseEventsRequested = parseEither parseJSON
decodePayload BrowseEventsResult = parseEither parseJSON
decodePayload BrowseEventsFailed = parseEither parseJSON
decodePayload BrowseAnnotationHistoryRequested = parseEither parseJSON
decodePayload BrowseAnnotationHistoryResult = parseEither parseJSON
decodePayload BrowseAnnotationHistoryFailed = parseEither parseJSON
decodePayload BrowseEntityTypesRequested = parseEither parseJSON
decodePayload BrowseEntityTypesResult = parseEither parseJSON
decodePayload BrowseEntityTypesFailed = parseEither parseJSON
decodePayload BrowseTagSchemasRequested = parseEither parseJSON
decodePayload BrowseTagSchemasResult = parseEither parseJSON
decodePayload BrowseTagSchemasFailed = parseEither parseJSON
decodePayload BrowseEnginesRequested = parseEither parseJSON
decodePayload BrowseEnginesResult = parseEither parseJSON
decodePayload BrowseEnginesFailed = parseEither parseJSON
decodePayload BrowseProfilesRequested = parseEither parseJSON
decodePayload BrowseProfilesResult = parseEither parseJSON
decodePayload BrowseProfilesFailed = parseEither parseJSON
decodePayload BrowseKbRequested = parseEither parseJSON
decodePayload BrowseKbResult = parseEither parseJSON
decodePayload BrowseKbFailed = parseEither parseJSON
decodePayload BrowseDirectoryRequested = parseEither parseJSON
decodePayload BrowseDirectoryResult = parseEither parseJSON
decodePayload BrowseDirectoryFailed = parseEither parseJSON
decodePayload BrowseClick = parseEither parseJSON
decodePayload BrowseResourceOpen = parseEither parseJSON
decodePayload BrowseResourceViewed = parseEither parseJSON
decodePayload BrowseEntityTypeClicked = parseEither parseJSON
decodePayload PanelToggle = parseEither parseJSON
decodePayload PanelOpen = parseEither parseJSON
decodePayload PanelClose = parseEither parseJSON
decodePayload ShellSidebarToggle = parseEither parseJSON
decodePayload TabsClose = parseEither parseJSON
decodePayload TabsReorder = parseEither parseJSON
decodePayload NavLinkClicked = parseEither parseJSON
decodePayload NavPush = parseEither parseJSON
decodePayload NavExternal = parseEither parseJSON
decodePayload BeckonHover = parseEither parseJSON
decodePayload BeckonFocus = parseEither parseJSON
decodePayload BeckonSparkle = parseEither parseJSON
decodePayload JobStarted = parseEither parseJSON
decodePayload JobAssigned = parseEither parseJSON
decodePayload JobCompleted = parseEither parseJSON
decodePayload JobFailed = parseEither parseJSON
decodePayload JobStart = parseEither parseJSON
decodePayload JobAssign = parseEither parseJSON
decodePayload JobReportProgress = parseEither parseJSON
decodePayload JobComplete = parseEither parseJSON
decodePayload JobFail = parseEither parseJSON
decodePayload JobCheckpoint = parseEither parseJSON
decodePayload JobQueued = parseEither parseJSON
decodePayload JobCancelRequested = parseEither parseJSON
decodePayload JobCancel = parseEither parseJSON
decodePayload JobLimitsRequested = parseEither parseJSON
decodePayload JobLimitsResult = parseEither parseJSON
decodePayload JobLimitsFailed = parseEither parseJSON
decodePayload JobStatusRequested = parseEither parseJSON
decodePayload JobCreate = parseEither parseJSON
decodePayload JobClaim = parseEither parseJSON
decodePayload JobStatusResult = parseEither parseJSON
decodePayload JobStatusFailed = parseEither parseJSON
decodePayload JobCreated = parseEither parseJSON
decodePayload JobCreateFailed = parseEither parseJSON
decodePayload JobClaimed = parseEither parseJSON
decodePayload JobClaimFailed = parseEither parseJSON
decodePayload JobCancelOk = parseEither parseJSON
decodePayload JobCancelFailed = parseEither parseJSON
decodePayload WeaveApplied = parseEither parseJSON
decodePayload SmeltSettled = parseEither parseJSON
decodePayload WeaveRebuild = parseEither parseJSON
decodePayload WeaveRebuildOk = parseEither parseJSON
decodePayload WeaveRebuildFailed = parseEither parseJSON
decodePayload SmeltRebuildAnchors = parseEither parseJSON
decodePayload SmeltRebuildAnchorsOk = parseEither parseJSON
decodePayload SmeltRebuildAnchorsFailed = parseEither parseJSON
decodePayload SettingsThemeChanged = parseEither parseJSON
decodePayload SettingsLineNumbersToggled = parseEither parseJSON
decodePayload SettingsLocaleChanged = parseEither parseJSON
decodePayload SettingsHoverDelayChanged = parseEither parseJSON
decodePayload BusResumeGap = parseEither parseJSON
decodePayload SessionJoined = parseEither parseJSON
decodePayload SessionLeft = parseEither parseJSON
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
