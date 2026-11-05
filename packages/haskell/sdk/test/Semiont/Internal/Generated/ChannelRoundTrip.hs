-- Generated from protocol/specs/src/bus/registry.json. Do not edit.
{-# LANGUAGE DataKinds, GADTs, KindSignatures, OverloadedStrings #-}
module Semiont.Internal.Generated.ChannelRoundTrip (roundTripChannel, channelMetadata, operationMetadata) where
import Data.Aeson (Value)
import Data.Text (Text)
import Semiont.Channels
roundTripChannel :: Text -> Value -> Either String Value
roundTripChannel name value = case name of
  "yield:created" -> encodePayload YieldCreated <$> decodePayload YieldCreated value
  "yield:cloned" -> encodePayload YieldCloned <$> decodePayload YieldCloned value
  "yield:updated" -> encodePayload YieldUpdated <$> decodePayload YieldUpdated value
  "yield:moved" -> encodePayload YieldMoved <$> decodePayload YieldMoved value
  "yield:representation-added" -> encodePayload YieldRepresentationAdded <$> decodePayload YieldRepresentationAdded value
  "yield:representation-removed" -> encodePayload YieldRepresentationRemoved <$> decodePayload YieldRepresentationRemoved value
  "yield:create" -> encodePayload YieldCreate <$> decodePayload YieldCreate value
  "yield:clone-persist" -> encodePayload YieldClonePersist <$> decodePayload YieldClonePersist value
  "yield:update" -> encodePayload YieldUpdate <$> decodePayload YieldUpdate value
  "yield:clone" -> encodePayload YieldClone <$> decodePayload YieldClone value
  "yield:clone-token-requested" -> encodePayload YieldCloneTokenRequested <$> decodePayload YieldCloneTokenRequested value
  "yield:clone-resource-requested" -> encodePayload YieldCloneResourceRequested <$> decodePayload YieldCloneResourceRequested value
  "yield:clone-create" -> encodePayload YieldCloneCreate <$> decodePayload YieldCloneCreate value
  "yield:create-ok" -> encodePayload YieldCreateOk <$> decodePayload YieldCreateOk value
  "yield:create-failed" -> encodePayload YieldCreateFailed <$> decodePayload YieldCreateFailed value
  "yield:clone-persist-ok" -> encodePayload YieldClonePersistOk <$> decodePayload YieldClonePersistOk value
  "yield:clone-persist-failed" -> encodePayload YieldClonePersistFailed <$> decodePayload YieldClonePersistFailed value
  "yield:update-ok" -> encodePayload YieldUpdateOk <$> decodePayload YieldUpdateOk value
  "yield:update-failed" -> encodePayload YieldUpdateFailed <$> decodePayload YieldUpdateFailed value
  "yield:clone-token-generated" -> encodePayload YieldCloneTokenGenerated <$> decodePayload YieldCloneTokenGenerated value
  "yield:clone-token-failed" -> encodePayload YieldCloneTokenFailed <$> decodePayload YieldCloneTokenFailed value
  "yield:clone-resource-result" -> encodePayload YieldCloneResourceResult <$> decodePayload YieldCloneResourceResult value
  "yield:clone-resource-failed" -> encodePayload YieldCloneResourceFailed <$> decodePayload YieldCloneResourceFailed value
  "yield:clone-created" -> encodePayload YieldCloneCreated <$> decodePayload YieldCloneCreated value
  "yield:clone-create-failed" -> encodePayload YieldCloneCreateFailed <$> decodePayload YieldCloneCreateFailed value
  "mark:added" -> encodePayload MarkAdded <$> decodePayload MarkAdded value
  "mark:removed" -> encodePayload MarkRemoved <$> decodePayload MarkRemoved value
  "mark:body-updated" -> encodePayload MarkBodyUpdated <$> decodePayload MarkBodyUpdated value
  "mark:entity-tag-added" -> encodePayload MarkEntityTagAdded <$> decodePayload MarkEntityTagAdded value
  "mark:entity-tag-removed" -> encodePayload MarkEntityTagRemoved <$> decodePayload MarkEntityTagRemoved value
  "mark:archived" -> encodePayload MarkArchived <$> decodePayload MarkArchived value
  "mark:unarchived" -> encodePayload MarkUnarchived <$> decodePayload MarkUnarchived value
  "mark:create-request" -> encodePayload MarkCreateRequest <$> decodePayload MarkCreateRequest value
  "mark:delete" -> encodePayload MarkDelete <$> decodePayload MarkDelete value
  "mark:update-body" -> encodePayload MarkUpdateBody <$> decodePayload MarkUpdateBody value
  "mark:archive" -> encodePayload MarkArchive <$> decodePayload MarkArchive value
  "mark:unarchive" -> encodePayload MarkUnarchive <$> decodePayload MarkUnarchive value
  "mark:update-entity-types" -> encodePayload MarkUpdateEntityTypes <$> decodePayload MarkUpdateEntityTypes value
  "mark:create-ok" -> encodePayload MarkCreateOk <$> decodePayload MarkCreateOk value
  "mark:create-failed" -> encodePayload MarkCreateFailed <$> decodePayload MarkCreateFailed value
  "mark:commit" -> encodePayload MarkCommit <$> decodePayload MarkCommit value
  "mark:commit-ok" -> encodePayload MarkCommitOk <$> decodePayload MarkCommitOk value
  "mark:commit-failed" -> encodePayload MarkCommitFailed <$> decodePayload MarkCommitFailed value
  "mark:delete-ok" -> encodePayload MarkDeleteOk <$> decodePayload MarkDeleteOk value
  "mark:delete-failed" -> encodePayload MarkDeleteFailed <$> decodePayload MarkDeleteFailed value
  "mark:archive-ok" -> encodePayload MarkArchiveOk <$> decodePayload MarkArchiveOk value
  "mark:archive-failed" -> encodePayload MarkArchiveFailed <$> decodePayload MarkArchiveFailed value
  "mark:unarchive-ok" -> encodePayload MarkUnarchiveOk <$> decodePayload MarkUnarchiveOk value
  "mark:unarchive-failed" -> encodePayload MarkUnarchiveFailed <$> decodePayload MarkUnarchiveFailed value
  "mark:update-entity-types-ok" -> encodePayload MarkUpdateEntityTypesOk <$> decodePayload MarkUpdateEntityTypesOk value
  "mark:update-entity-types-failed" -> encodePayload MarkUpdateEntityTypesFailed <$> decodePayload MarkUpdateEntityTypesFailed value
  "mark:body-update-failed" -> encodePayload MarkBodyUpdateFailed <$> decodePayload MarkBodyUpdateFailed value
  "mark:requested" -> encodePayload MarkRequested <$> decodePayload MarkRequested value
  "mark:submit" -> encodePayload MarkSubmit <$> decodePayload MarkSubmit value
  "mark:delegate-timeout" -> encodePayload MarkDelegateTimeout <$> decodePayload MarkDelegateTimeout value
  "mark:create-error" -> encodePayload MarkCreateError <$> decodePayload MarkCreateError value
  "mark:delete-error" -> encodePayload MarkDeleteError <$> decodePayload MarkDeleteError value
  "bind:body-error" -> encodePayload BindBodyError <$> decodePayload BindBodyError value
  "frame:entity-type-added" -> encodePayload FrameEntityTypeAdded <$> decodePayload FrameEntityTypeAdded value
  "frame:tag-schema-added" -> encodePayload FrameTagSchemaAdded <$> decodePayload FrameTagSchemaAdded value
  "frame:add-entity-type" -> encodePayload FrameAddEntityType <$> decodePayload FrameAddEntityType value
  "frame:add-tag-schema" -> encodePayload FrameAddTagSchema <$> decodePayload FrameAddTagSchema value
  "frame:entity-type-add-ok" -> encodePayload FrameEntityTypeAddOk <$> decodePayload FrameEntityTypeAddOk value
  "frame:entity-type-add-failed" -> encodePayload FrameEntityTypeAddFailed <$> decodePayload FrameEntityTypeAddFailed value
  "frame:tag-schema-add-ok" -> encodePayload FrameTagSchemaAddOk <$> decodePayload FrameTagSchemaAddOk value
  "frame:tag-schema-add-failed" -> encodePayload FrameTagSchemaAddFailed <$> decodePayload FrameTagSchemaAddFailed value
  "principal:profiled" -> encodePayload PrincipalProfiled <$> decodePayload PrincipalProfiled value
  "principal:profile" -> encodePayload PrincipalProfile <$> decodePayload PrincipalProfile value
  "bind:initiate" -> encodePayload BindInitiate <$> decodePayload BindInitiate value
  "bind:update-body" -> encodePayload BindUpdateBody <$> decodePayload BindUpdateBody value
  "bind:body-updated" -> encodePayload BindBodyUpdated <$> decodePayload BindBodyUpdated value
  "bind:body-update-failed" -> encodePayload BindBodyUpdateFailed <$> decodePayload BindBodyUpdateFailed value
  "match:search-requested" -> encodePayload MatchSearchRequested <$> decodePayload MatchSearchRequested value
  "match:search-results" -> encodePayload MatchSearchResults <$> decodePayload MatchSearchResults value
  "match:search-failed" -> encodePayload MatchSearchFailed <$> decodePayload MatchSearchFailed value
  "match:resources-requested" -> encodePayload MatchResourcesRequested <$> decodePayload MatchResourcesRequested value
  "match:resources-result" -> encodePayload MatchResourcesResult <$> decodePayload MatchResourcesResult value
  "match:resources-failed" -> encodePayload MatchResourcesFailed <$> decodePayload MatchResourcesFailed value
  "match:limits-requested" -> encodePayload MatchLimitsRequested <$> decodePayload MatchLimitsRequested value
  "match:limits-result" -> encodePayload MatchLimitsResult <$> decodePayload MatchLimitsResult value
  "match:limits-failed" -> encodePayload MatchLimitsFailed <$> decodePayload MatchLimitsFailed value
  "gather:requested" -> encodePayload GatherRequested <$> decodePayload GatherRequested value
  "gather:complete" -> encodePayload GatherComplete <$> decodePayload GatherComplete value
  "gather:failed" -> encodePayload GatherFailed <$> decodePayload GatherFailed value
  "gather:resource-requested" -> encodePayload GatherResourceRequested <$> decodePayload GatherResourceRequested value
  "gather:resource-complete" -> encodePayload GatherResourceComplete <$> decodePayload GatherResourceComplete value
  "gather:resource-failed" -> encodePayload GatherResourceFailed <$> decodePayload GatherResourceFailed value
  "gather:summary-requested" -> encodePayload GatherSummaryRequested <$> decodePayload GatherSummaryRequested value
  "gather:summary-result" -> encodePayload GatherSummaryResult <$> decodePayload GatherSummaryResult value
  "gather:summary-failed" -> encodePayload GatherSummaryFailed <$> decodePayload GatherSummaryFailed value
  "gather:referenced-by-requested" -> encodePayload GatherReferencedByRequested <$> decodePayload GatherReferencedByRequested value
  "gather:referenced-by-result" -> encodePayload GatherReferencedByResult <$> decodePayload GatherReferencedByResult value
  "gather:referenced-by-failed" -> encodePayload GatherReferencedByFailed <$> decodePayload GatherReferencedByFailed value
  "gather:limits-requested" -> encodePayload GatherLimitsRequested <$> decodePayload GatherLimitsRequested value
  "gather:limits-result" -> encodePayload GatherLimitsResult <$> decodePayload GatherLimitsResult value
  "gather:limits-failed" -> encodePayload GatherLimitsFailed <$> decodePayload GatherLimitsFailed value
  "browse:resource-requested" -> encodePayload BrowseResourceRequested <$> decodePayload BrowseResourceRequested value
  "browse:resource-result" -> encodePayload BrowseResourceResult <$> decodePayload BrowseResourceResult value
  "browse:resource-failed" -> encodePayload BrowseResourceFailed <$> decodePayload BrowseResourceFailed value
  "browse:resources-requested" -> encodePayload BrowseResourcesRequested <$> decodePayload BrowseResourcesRequested value
  "browse:resources-result" -> encodePayload BrowseResourcesResult <$> decodePayload BrowseResourcesResult value
  "browse:resources-failed" -> encodePayload BrowseResourcesFailed <$> decodePayload BrowseResourcesFailed value
  "browse:annotation-requested" -> encodePayload BrowseAnnotationRequested <$> decodePayload BrowseAnnotationRequested value
  "browse:annotation-result" -> encodePayload BrowseAnnotationResult <$> decodePayload BrowseAnnotationResult value
  "browse:annotation-failed" -> encodePayload BrowseAnnotationFailed <$> decodePayload BrowseAnnotationFailed value
  "browse:events-requested" -> encodePayload BrowseEventsRequested <$> decodePayload BrowseEventsRequested value
  "browse:events-result" -> encodePayload BrowseEventsResult <$> decodePayload BrowseEventsResult value
  "browse:events-failed" -> encodePayload BrowseEventsFailed <$> decodePayload BrowseEventsFailed value
  "browse:annotation-history-requested" -> encodePayload BrowseAnnotationHistoryRequested <$> decodePayload BrowseAnnotationHistoryRequested value
  "browse:annotation-history-result" -> encodePayload BrowseAnnotationHistoryResult <$> decodePayload BrowseAnnotationHistoryResult value
  "browse:annotation-history-failed" -> encodePayload BrowseAnnotationHistoryFailed <$> decodePayload BrowseAnnotationHistoryFailed value
  "browse:entity-types-requested" -> encodePayload BrowseEntityTypesRequested <$> decodePayload BrowseEntityTypesRequested value
  "browse:entity-types-result" -> encodePayload BrowseEntityTypesResult <$> decodePayload BrowseEntityTypesResult value
  "browse:entity-types-failed" -> encodePayload BrowseEntityTypesFailed <$> decodePayload BrowseEntityTypesFailed value
  "browse:tag-schemas-requested" -> encodePayload BrowseTagSchemasRequested <$> decodePayload BrowseTagSchemasRequested value
  "browse:tag-schemas-result" -> encodePayload BrowseTagSchemasResult <$> decodePayload BrowseTagSchemasResult value
  "browse:tag-schemas-failed" -> encodePayload BrowseTagSchemasFailed <$> decodePayload BrowseTagSchemasFailed value
  "browse:engines-requested" -> encodePayload BrowseEnginesRequested <$> decodePayload BrowseEnginesRequested value
  "browse:engines-result" -> encodePayload BrowseEnginesResult <$> decodePayload BrowseEnginesResult value
  "browse:engines-failed" -> encodePayload BrowseEnginesFailed <$> decodePayload BrowseEnginesFailed value
  "browse:profiles-requested" -> encodePayload BrowseProfilesRequested <$> decodePayload BrowseProfilesRequested value
  "browse:profiles-result" -> encodePayload BrowseProfilesResult <$> decodePayload BrowseProfilesResult value
  "browse:profiles-failed" -> encodePayload BrowseProfilesFailed <$> decodePayload BrowseProfilesFailed value
  "browse:kb-requested" -> encodePayload BrowseKbRequested <$> decodePayload BrowseKbRequested value
  "browse:kb-result" -> encodePayload BrowseKbResult <$> decodePayload BrowseKbResult value
  "browse:kb-failed" -> encodePayload BrowseKbFailed <$> decodePayload BrowseKbFailed value
  "browse:directory-requested" -> encodePayload BrowseDirectoryRequested <$> decodePayload BrowseDirectoryRequested value
  "browse:directory-result" -> encodePayload BrowseDirectoryResult <$> decodePayload BrowseDirectoryResult value
  "browse:directory-failed" -> encodePayload BrowseDirectoryFailed <$> decodePayload BrowseDirectoryFailed value
  "browse:click" -> encodePayload BrowseClick <$> decodePayload BrowseClick value
  "browse:resource-open" -> encodePayload BrowseResourceOpen <$> decodePayload BrowseResourceOpen value
  "browse:resource-viewed" -> encodePayload BrowseResourceViewed <$> decodePayload BrowseResourceViewed value
  "browse:entity-type-clicked" -> encodePayload BrowseEntityTypeClicked <$> decodePayload BrowseEntityTypeClicked value
  "panel:toggle" -> encodePayload PanelToggle <$> decodePayload PanelToggle value
  "panel:open" -> encodePayload PanelOpen <$> decodePayload PanelOpen value
  "panel:close" -> encodePayload PanelClose <$> decodePayload PanelClose value
  "shell:sidebar-toggle" -> encodePayload ShellSidebarToggle <$> decodePayload ShellSidebarToggle value
  "tabs:close" -> encodePayload TabsClose <$> decodePayload TabsClose value
  "tabs:reorder" -> encodePayload TabsReorder <$> decodePayload TabsReorder value
  "nav:link-clicked" -> encodePayload NavLinkClicked <$> decodePayload NavLinkClicked value
  "nav:push" -> encodePayload NavPush <$> decodePayload NavPush value
  "nav:external" -> encodePayload NavExternal <$> decodePayload NavExternal value
  "beckon:hover" -> encodePayload BeckonHover <$> decodePayload BeckonHover value
  "beckon:focus" -> encodePayload BeckonFocus <$> decodePayload BeckonFocus value
  "beckon:sparkle" -> encodePayload BeckonSparkle <$> decodePayload BeckonSparkle value
  "job:started" -> encodePayload JobStarted <$> decodePayload JobStarted value
  "job:assigned" -> encodePayload JobAssigned <$> decodePayload JobAssigned value
  "job:completed" -> encodePayload JobCompleted <$> decodePayload JobCompleted value
  "job:failed" -> encodePayload JobFailed <$> decodePayload JobFailed value
  "job:start" -> encodePayload JobStart <$> decodePayload JobStart value
  "job:assign" -> encodePayload JobAssign <$> decodePayload JobAssign value
  "job:report-progress" -> encodePayload JobReportProgress <$> decodePayload JobReportProgress value
  "job:complete" -> encodePayload JobComplete <$> decodePayload JobComplete value
  "job:fail" -> encodePayload JobFail <$> decodePayload JobFail value
  "job:checkpoint" -> encodePayload JobCheckpoint <$> decodePayload JobCheckpoint value
  "job:queued" -> encodePayload JobQueued <$> decodePayload JobQueued value
  "job:cancel-requested" -> encodePayload JobCancelRequested <$> decodePayload JobCancelRequested value
  "job:cancel" -> encodePayload JobCancel <$> decodePayload JobCancel value
  "job:limits-requested" -> encodePayload JobLimitsRequested <$> decodePayload JobLimitsRequested value
  "job:limits-result" -> encodePayload JobLimitsResult <$> decodePayload JobLimitsResult value
  "job:limits-failed" -> encodePayload JobLimitsFailed <$> decodePayload JobLimitsFailed value
  "job:status-requested" -> encodePayload JobStatusRequested <$> decodePayload JobStatusRequested value
  "job:create" -> encodePayload JobCreate <$> decodePayload JobCreate value
  "job:claim" -> encodePayload JobClaim <$> decodePayload JobClaim value
  "job:status-result" -> encodePayload JobStatusResult <$> decodePayload JobStatusResult value
  "job:status-failed" -> encodePayload JobStatusFailed <$> decodePayload JobStatusFailed value
  "job:created" -> encodePayload JobCreated <$> decodePayload JobCreated value
  "job:create-failed" -> encodePayload JobCreateFailed <$> decodePayload JobCreateFailed value
  "job:claimed" -> encodePayload JobClaimed <$> decodePayload JobClaimed value
  "job:claim-failed" -> encodePayload JobClaimFailed <$> decodePayload JobClaimFailed value
  "job:cancel-ok" -> encodePayload JobCancelOk <$> decodePayload JobCancelOk value
  "job:cancel-failed" -> encodePayload JobCancelFailed <$> decodePayload JobCancelFailed value
  "weave:applied" -> encodePayload WeaveApplied <$> decodePayload WeaveApplied value
  "smelt:settled" -> encodePayload SmeltSettled <$> decodePayload SmeltSettled value
  "weave:rebuild" -> encodePayload WeaveRebuild <$> decodePayload WeaveRebuild value
  "weave:rebuild-ok" -> encodePayload WeaveRebuildOk <$> decodePayload WeaveRebuildOk value
  "weave:rebuild-failed" -> encodePayload WeaveRebuildFailed <$> decodePayload WeaveRebuildFailed value
  "smelt:rebuild-anchors" -> encodePayload SmeltRebuildAnchors <$> decodePayload SmeltRebuildAnchors value
  "smelt:rebuild-anchors-ok" -> encodePayload SmeltRebuildAnchorsOk <$> decodePayload SmeltRebuildAnchorsOk value
  "smelt:rebuild-anchors-failed" -> encodePayload SmeltRebuildAnchorsFailed <$> decodePayload SmeltRebuildAnchorsFailed value
  "settings:theme-changed" -> encodePayload SettingsThemeChanged <$> decodePayload SettingsThemeChanged value
  "settings:line-numbers-toggled" -> encodePayload SettingsLineNumbersToggled <$> decodePayload SettingsLineNumbersToggled value
  "settings:locale-changed" -> encodePayload SettingsLocaleChanged <$> decodePayload SettingsLocaleChanged value
  "settings:hover-delay-changed" -> encodePayload SettingsHoverDelayChanged <$> decodePayload SettingsHoverDelayChanged value
  "bus:resume-gap" -> encodePayload BusResumeGap <$> decodePayload BusResumeGap value
  "session:joined" -> encodePayload SessionJoined <$> decodePayload SessionJoined value
  "session:left" -> encodePayload SessionLeft <$> decodePayload SessionLeft value
  _ -> Left "unknown channel in round-trip dispatcher"
channelMetadata :: Text -> Either String (Text, Text, Bool)
channelMetadata name = case name of
  "yield:created" -> Right (channelName YieldCreated, channelSchema YieldCreated, channelIsScoped YieldCreated)
  "yield:cloned" -> Right (channelName YieldCloned, channelSchema YieldCloned, channelIsScoped YieldCloned)
  "yield:updated" -> Right (channelName YieldUpdated, channelSchema YieldUpdated, channelIsScoped YieldUpdated)
  "yield:moved" -> Right (channelName YieldMoved, channelSchema YieldMoved, channelIsScoped YieldMoved)
  "yield:representation-added" -> Right (channelName YieldRepresentationAdded, channelSchema YieldRepresentationAdded, channelIsScoped YieldRepresentationAdded)
  "yield:representation-removed" -> Right (channelName YieldRepresentationRemoved, channelSchema YieldRepresentationRemoved, channelIsScoped YieldRepresentationRemoved)
  "yield:create" -> Right (channelName YieldCreate, channelSchema YieldCreate, channelIsScoped YieldCreate)
  "yield:clone-persist" -> Right (channelName YieldClonePersist, channelSchema YieldClonePersist, channelIsScoped YieldClonePersist)
  "yield:update" -> Right (channelName YieldUpdate, channelSchema YieldUpdate, channelIsScoped YieldUpdate)
  "yield:clone" -> Right (channelName YieldClone, channelSchema YieldClone, channelIsScoped YieldClone)
  "yield:clone-token-requested" -> Right (channelName YieldCloneTokenRequested, channelSchema YieldCloneTokenRequested, channelIsScoped YieldCloneTokenRequested)
  "yield:clone-resource-requested" -> Right (channelName YieldCloneResourceRequested, channelSchema YieldCloneResourceRequested, channelIsScoped YieldCloneResourceRequested)
  "yield:clone-create" -> Right (channelName YieldCloneCreate, channelSchema YieldCloneCreate, channelIsScoped YieldCloneCreate)
  "yield:create-ok" -> Right (channelName YieldCreateOk, channelSchema YieldCreateOk, channelIsScoped YieldCreateOk)
  "yield:create-failed" -> Right (channelName YieldCreateFailed, channelSchema YieldCreateFailed, channelIsScoped YieldCreateFailed)
  "yield:clone-persist-ok" -> Right (channelName YieldClonePersistOk, channelSchema YieldClonePersistOk, channelIsScoped YieldClonePersistOk)
  "yield:clone-persist-failed" -> Right (channelName YieldClonePersistFailed, channelSchema YieldClonePersistFailed, channelIsScoped YieldClonePersistFailed)
  "yield:update-ok" -> Right (channelName YieldUpdateOk, channelSchema YieldUpdateOk, channelIsScoped YieldUpdateOk)
  "yield:update-failed" -> Right (channelName YieldUpdateFailed, channelSchema YieldUpdateFailed, channelIsScoped YieldUpdateFailed)
  "yield:clone-token-generated" -> Right (channelName YieldCloneTokenGenerated, channelSchema YieldCloneTokenGenerated, channelIsScoped YieldCloneTokenGenerated)
  "yield:clone-token-failed" -> Right (channelName YieldCloneTokenFailed, channelSchema YieldCloneTokenFailed, channelIsScoped YieldCloneTokenFailed)
  "yield:clone-resource-result" -> Right (channelName YieldCloneResourceResult, channelSchema YieldCloneResourceResult, channelIsScoped YieldCloneResourceResult)
  "yield:clone-resource-failed" -> Right (channelName YieldCloneResourceFailed, channelSchema YieldCloneResourceFailed, channelIsScoped YieldCloneResourceFailed)
  "yield:clone-created" -> Right (channelName YieldCloneCreated, channelSchema YieldCloneCreated, channelIsScoped YieldCloneCreated)
  "yield:clone-create-failed" -> Right (channelName YieldCloneCreateFailed, channelSchema YieldCloneCreateFailed, channelIsScoped YieldCloneCreateFailed)
  "mark:added" -> Right (channelName MarkAdded, channelSchema MarkAdded, channelIsScoped MarkAdded)
  "mark:removed" -> Right (channelName MarkRemoved, channelSchema MarkRemoved, channelIsScoped MarkRemoved)
  "mark:body-updated" -> Right (channelName MarkBodyUpdated, channelSchema MarkBodyUpdated, channelIsScoped MarkBodyUpdated)
  "mark:entity-tag-added" -> Right (channelName MarkEntityTagAdded, channelSchema MarkEntityTagAdded, channelIsScoped MarkEntityTagAdded)
  "mark:entity-tag-removed" -> Right (channelName MarkEntityTagRemoved, channelSchema MarkEntityTagRemoved, channelIsScoped MarkEntityTagRemoved)
  "mark:archived" -> Right (channelName MarkArchived, channelSchema MarkArchived, channelIsScoped MarkArchived)
  "mark:unarchived" -> Right (channelName MarkUnarchived, channelSchema MarkUnarchived, channelIsScoped MarkUnarchived)
  "mark:create-request" -> Right (channelName MarkCreateRequest, channelSchema MarkCreateRequest, channelIsScoped MarkCreateRequest)
  "mark:delete" -> Right (channelName MarkDelete, channelSchema MarkDelete, channelIsScoped MarkDelete)
  "mark:update-body" -> Right (channelName MarkUpdateBody, channelSchema MarkUpdateBody, channelIsScoped MarkUpdateBody)
  "mark:archive" -> Right (channelName MarkArchive, channelSchema MarkArchive, channelIsScoped MarkArchive)
  "mark:unarchive" -> Right (channelName MarkUnarchive, channelSchema MarkUnarchive, channelIsScoped MarkUnarchive)
  "mark:update-entity-types" -> Right (channelName MarkUpdateEntityTypes, channelSchema MarkUpdateEntityTypes, channelIsScoped MarkUpdateEntityTypes)
  "mark:create-ok" -> Right (channelName MarkCreateOk, channelSchema MarkCreateOk, channelIsScoped MarkCreateOk)
  "mark:create-failed" -> Right (channelName MarkCreateFailed, channelSchema MarkCreateFailed, channelIsScoped MarkCreateFailed)
  "mark:commit" -> Right (channelName MarkCommit, channelSchema MarkCommit, channelIsScoped MarkCommit)
  "mark:commit-ok" -> Right (channelName MarkCommitOk, channelSchema MarkCommitOk, channelIsScoped MarkCommitOk)
  "mark:commit-failed" -> Right (channelName MarkCommitFailed, channelSchema MarkCommitFailed, channelIsScoped MarkCommitFailed)
  "mark:delete-ok" -> Right (channelName MarkDeleteOk, channelSchema MarkDeleteOk, channelIsScoped MarkDeleteOk)
  "mark:delete-failed" -> Right (channelName MarkDeleteFailed, channelSchema MarkDeleteFailed, channelIsScoped MarkDeleteFailed)
  "mark:archive-ok" -> Right (channelName MarkArchiveOk, channelSchema MarkArchiveOk, channelIsScoped MarkArchiveOk)
  "mark:archive-failed" -> Right (channelName MarkArchiveFailed, channelSchema MarkArchiveFailed, channelIsScoped MarkArchiveFailed)
  "mark:unarchive-ok" -> Right (channelName MarkUnarchiveOk, channelSchema MarkUnarchiveOk, channelIsScoped MarkUnarchiveOk)
  "mark:unarchive-failed" -> Right (channelName MarkUnarchiveFailed, channelSchema MarkUnarchiveFailed, channelIsScoped MarkUnarchiveFailed)
  "mark:update-entity-types-ok" -> Right (channelName MarkUpdateEntityTypesOk, channelSchema MarkUpdateEntityTypesOk, channelIsScoped MarkUpdateEntityTypesOk)
  "mark:update-entity-types-failed" -> Right (channelName MarkUpdateEntityTypesFailed, channelSchema MarkUpdateEntityTypesFailed, channelIsScoped MarkUpdateEntityTypesFailed)
  "mark:body-update-failed" -> Right (channelName MarkBodyUpdateFailed, channelSchema MarkBodyUpdateFailed, channelIsScoped MarkBodyUpdateFailed)
  "mark:requested" -> Right (channelName MarkRequested, channelSchema MarkRequested, channelIsScoped MarkRequested)
  "mark:submit" -> Right (channelName MarkSubmit, channelSchema MarkSubmit, channelIsScoped MarkSubmit)
  "mark:delegate-timeout" -> Right (channelName MarkDelegateTimeout, channelSchema MarkDelegateTimeout, channelIsScoped MarkDelegateTimeout)
  "mark:create-error" -> Right (channelName MarkCreateError, channelSchema MarkCreateError, channelIsScoped MarkCreateError)
  "mark:delete-error" -> Right (channelName MarkDeleteError, channelSchema MarkDeleteError, channelIsScoped MarkDeleteError)
  "bind:body-error" -> Right (channelName BindBodyError, channelSchema BindBodyError, channelIsScoped BindBodyError)
  "frame:entity-type-added" -> Right (channelName FrameEntityTypeAdded, channelSchema FrameEntityTypeAdded, channelIsScoped FrameEntityTypeAdded)
  "frame:tag-schema-added" -> Right (channelName FrameTagSchemaAdded, channelSchema FrameTagSchemaAdded, channelIsScoped FrameTagSchemaAdded)
  "frame:add-entity-type" -> Right (channelName FrameAddEntityType, channelSchema FrameAddEntityType, channelIsScoped FrameAddEntityType)
  "frame:add-tag-schema" -> Right (channelName FrameAddTagSchema, channelSchema FrameAddTagSchema, channelIsScoped FrameAddTagSchema)
  "frame:entity-type-add-ok" -> Right (channelName FrameEntityTypeAddOk, channelSchema FrameEntityTypeAddOk, channelIsScoped FrameEntityTypeAddOk)
  "frame:entity-type-add-failed" -> Right (channelName FrameEntityTypeAddFailed, channelSchema FrameEntityTypeAddFailed, channelIsScoped FrameEntityTypeAddFailed)
  "frame:tag-schema-add-ok" -> Right (channelName FrameTagSchemaAddOk, channelSchema FrameTagSchemaAddOk, channelIsScoped FrameTagSchemaAddOk)
  "frame:tag-schema-add-failed" -> Right (channelName FrameTagSchemaAddFailed, channelSchema FrameTagSchemaAddFailed, channelIsScoped FrameTagSchemaAddFailed)
  "principal:profiled" -> Right (channelName PrincipalProfiled, channelSchema PrincipalProfiled, channelIsScoped PrincipalProfiled)
  "principal:profile" -> Right (channelName PrincipalProfile, channelSchema PrincipalProfile, channelIsScoped PrincipalProfile)
  "bind:initiate" -> Right (channelName BindInitiate, channelSchema BindInitiate, channelIsScoped BindInitiate)
  "bind:update-body" -> Right (channelName BindUpdateBody, channelSchema BindUpdateBody, channelIsScoped BindUpdateBody)
  "bind:body-updated" -> Right (channelName BindBodyUpdated, channelSchema BindBodyUpdated, channelIsScoped BindBodyUpdated)
  "bind:body-update-failed" -> Right (channelName BindBodyUpdateFailed, channelSchema BindBodyUpdateFailed, channelIsScoped BindBodyUpdateFailed)
  "match:search-requested" -> Right (channelName MatchSearchRequested, channelSchema MatchSearchRequested, channelIsScoped MatchSearchRequested)
  "match:search-results" -> Right (channelName MatchSearchResults, channelSchema MatchSearchResults, channelIsScoped MatchSearchResults)
  "match:search-failed" -> Right (channelName MatchSearchFailed, channelSchema MatchSearchFailed, channelIsScoped MatchSearchFailed)
  "match:resources-requested" -> Right (channelName MatchResourcesRequested, channelSchema MatchResourcesRequested, channelIsScoped MatchResourcesRequested)
  "match:resources-result" -> Right (channelName MatchResourcesResult, channelSchema MatchResourcesResult, channelIsScoped MatchResourcesResult)
  "match:resources-failed" -> Right (channelName MatchResourcesFailed, channelSchema MatchResourcesFailed, channelIsScoped MatchResourcesFailed)
  "match:limits-requested" -> Right (channelName MatchLimitsRequested, channelSchema MatchLimitsRequested, channelIsScoped MatchLimitsRequested)
  "match:limits-result" -> Right (channelName MatchLimitsResult, channelSchema MatchLimitsResult, channelIsScoped MatchLimitsResult)
  "match:limits-failed" -> Right (channelName MatchLimitsFailed, channelSchema MatchLimitsFailed, channelIsScoped MatchLimitsFailed)
  "gather:requested" -> Right (channelName GatherRequested, channelSchema GatherRequested, channelIsScoped GatherRequested)
  "gather:complete" -> Right (channelName GatherComplete, channelSchema GatherComplete, channelIsScoped GatherComplete)
  "gather:failed" -> Right (channelName GatherFailed, channelSchema GatherFailed, channelIsScoped GatherFailed)
  "gather:resource-requested" -> Right (channelName GatherResourceRequested, channelSchema GatherResourceRequested, channelIsScoped GatherResourceRequested)
  "gather:resource-complete" -> Right (channelName GatherResourceComplete, channelSchema GatherResourceComplete, channelIsScoped GatherResourceComplete)
  "gather:resource-failed" -> Right (channelName GatherResourceFailed, channelSchema GatherResourceFailed, channelIsScoped GatherResourceFailed)
  "gather:summary-requested" -> Right (channelName GatherSummaryRequested, channelSchema GatherSummaryRequested, channelIsScoped GatherSummaryRequested)
  "gather:summary-result" -> Right (channelName GatherSummaryResult, channelSchema GatherSummaryResult, channelIsScoped GatherSummaryResult)
  "gather:summary-failed" -> Right (channelName GatherSummaryFailed, channelSchema GatherSummaryFailed, channelIsScoped GatherSummaryFailed)
  "gather:referenced-by-requested" -> Right (channelName GatherReferencedByRequested, channelSchema GatherReferencedByRequested, channelIsScoped GatherReferencedByRequested)
  "gather:referenced-by-result" -> Right (channelName GatherReferencedByResult, channelSchema GatherReferencedByResult, channelIsScoped GatherReferencedByResult)
  "gather:referenced-by-failed" -> Right (channelName GatherReferencedByFailed, channelSchema GatherReferencedByFailed, channelIsScoped GatherReferencedByFailed)
  "gather:limits-requested" -> Right (channelName GatherLimitsRequested, channelSchema GatherLimitsRequested, channelIsScoped GatherLimitsRequested)
  "gather:limits-result" -> Right (channelName GatherLimitsResult, channelSchema GatherLimitsResult, channelIsScoped GatherLimitsResult)
  "gather:limits-failed" -> Right (channelName GatherLimitsFailed, channelSchema GatherLimitsFailed, channelIsScoped GatherLimitsFailed)
  "browse:resource-requested" -> Right (channelName BrowseResourceRequested, channelSchema BrowseResourceRequested, channelIsScoped BrowseResourceRequested)
  "browse:resource-result" -> Right (channelName BrowseResourceResult, channelSchema BrowseResourceResult, channelIsScoped BrowseResourceResult)
  "browse:resource-failed" -> Right (channelName BrowseResourceFailed, channelSchema BrowseResourceFailed, channelIsScoped BrowseResourceFailed)
  "browse:resources-requested" -> Right (channelName BrowseResourcesRequested, channelSchema BrowseResourcesRequested, channelIsScoped BrowseResourcesRequested)
  "browse:resources-result" -> Right (channelName BrowseResourcesResult, channelSchema BrowseResourcesResult, channelIsScoped BrowseResourcesResult)
  "browse:resources-failed" -> Right (channelName BrowseResourcesFailed, channelSchema BrowseResourcesFailed, channelIsScoped BrowseResourcesFailed)
  "browse:annotation-requested" -> Right (channelName BrowseAnnotationRequested, channelSchema BrowseAnnotationRequested, channelIsScoped BrowseAnnotationRequested)
  "browse:annotation-result" -> Right (channelName BrowseAnnotationResult, channelSchema BrowseAnnotationResult, channelIsScoped BrowseAnnotationResult)
  "browse:annotation-failed" -> Right (channelName BrowseAnnotationFailed, channelSchema BrowseAnnotationFailed, channelIsScoped BrowseAnnotationFailed)
  "browse:events-requested" -> Right (channelName BrowseEventsRequested, channelSchema BrowseEventsRequested, channelIsScoped BrowseEventsRequested)
  "browse:events-result" -> Right (channelName BrowseEventsResult, channelSchema BrowseEventsResult, channelIsScoped BrowseEventsResult)
  "browse:events-failed" -> Right (channelName BrowseEventsFailed, channelSchema BrowseEventsFailed, channelIsScoped BrowseEventsFailed)
  "browse:annotation-history-requested" -> Right (channelName BrowseAnnotationHistoryRequested, channelSchema BrowseAnnotationHistoryRequested, channelIsScoped BrowseAnnotationHistoryRequested)
  "browse:annotation-history-result" -> Right (channelName BrowseAnnotationHistoryResult, channelSchema BrowseAnnotationHistoryResult, channelIsScoped BrowseAnnotationHistoryResult)
  "browse:annotation-history-failed" -> Right (channelName BrowseAnnotationHistoryFailed, channelSchema BrowseAnnotationHistoryFailed, channelIsScoped BrowseAnnotationHistoryFailed)
  "browse:entity-types-requested" -> Right (channelName BrowseEntityTypesRequested, channelSchema BrowseEntityTypesRequested, channelIsScoped BrowseEntityTypesRequested)
  "browse:entity-types-result" -> Right (channelName BrowseEntityTypesResult, channelSchema BrowseEntityTypesResult, channelIsScoped BrowseEntityTypesResult)
  "browse:entity-types-failed" -> Right (channelName BrowseEntityTypesFailed, channelSchema BrowseEntityTypesFailed, channelIsScoped BrowseEntityTypesFailed)
  "browse:tag-schemas-requested" -> Right (channelName BrowseTagSchemasRequested, channelSchema BrowseTagSchemasRequested, channelIsScoped BrowseTagSchemasRequested)
  "browse:tag-schemas-result" -> Right (channelName BrowseTagSchemasResult, channelSchema BrowseTagSchemasResult, channelIsScoped BrowseTagSchemasResult)
  "browse:tag-schemas-failed" -> Right (channelName BrowseTagSchemasFailed, channelSchema BrowseTagSchemasFailed, channelIsScoped BrowseTagSchemasFailed)
  "browse:engines-requested" -> Right (channelName BrowseEnginesRequested, channelSchema BrowseEnginesRequested, channelIsScoped BrowseEnginesRequested)
  "browse:engines-result" -> Right (channelName BrowseEnginesResult, channelSchema BrowseEnginesResult, channelIsScoped BrowseEnginesResult)
  "browse:engines-failed" -> Right (channelName BrowseEnginesFailed, channelSchema BrowseEnginesFailed, channelIsScoped BrowseEnginesFailed)
  "browse:profiles-requested" -> Right (channelName BrowseProfilesRequested, channelSchema BrowseProfilesRequested, channelIsScoped BrowseProfilesRequested)
  "browse:profiles-result" -> Right (channelName BrowseProfilesResult, channelSchema BrowseProfilesResult, channelIsScoped BrowseProfilesResult)
  "browse:profiles-failed" -> Right (channelName BrowseProfilesFailed, channelSchema BrowseProfilesFailed, channelIsScoped BrowseProfilesFailed)
  "browse:kb-requested" -> Right (channelName BrowseKbRequested, channelSchema BrowseKbRequested, channelIsScoped BrowseKbRequested)
  "browse:kb-result" -> Right (channelName BrowseKbResult, channelSchema BrowseKbResult, channelIsScoped BrowseKbResult)
  "browse:kb-failed" -> Right (channelName BrowseKbFailed, channelSchema BrowseKbFailed, channelIsScoped BrowseKbFailed)
  "browse:directory-requested" -> Right (channelName BrowseDirectoryRequested, channelSchema BrowseDirectoryRequested, channelIsScoped BrowseDirectoryRequested)
  "browse:directory-result" -> Right (channelName BrowseDirectoryResult, channelSchema BrowseDirectoryResult, channelIsScoped BrowseDirectoryResult)
  "browse:directory-failed" -> Right (channelName BrowseDirectoryFailed, channelSchema BrowseDirectoryFailed, channelIsScoped BrowseDirectoryFailed)
  "browse:click" -> Right (channelName BrowseClick, channelSchema BrowseClick, channelIsScoped BrowseClick)
  "browse:resource-open" -> Right (channelName BrowseResourceOpen, channelSchema BrowseResourceOpen, channelIsScoped BrowseResourceOpen)
  "browse:resource-viewed" -> Right (channelName BrowseResourceViewed, channelSchema BrowseResourceViewed, channelIsScoped BrowseResourceViewed)
  "browse:entity-type-clicked" -> Right (channelName BrowseEntityTypeClicked, channelSchema BrowseEntityTypeClicked, channelIsScoped BrowseEntityTypeClicked)
  "panel:toggle" -> Right (channelName PanelToggle, channelSchema PanelToggle, channelIsScoped PanelToggle)
  "panel:open" -> Right (channelName PanelOpen, channelSchema PanelOpen, channelIsScoped PanelOpen)
  "panel:close" -> Right (channelName PanelClose, channelSchema PanelClose, channelIsScoped PanelClose)
  "shell:sidebar-toggle" -> Right (channelName ShellSidebarToggle, channelSchema ShellSidebarToggle, channelIsScoped ShellSidebarToggle)
  "tabs:close" -> Right (channelName TabsClose, channelSchema TabsClose, channelIsScoped TabsClose)
  "tabs:reorder" -> Right (channelName TabsReorder, channelSchema TabsReorder, channelIsScoped TabsReorder)
  "nav:link-clicked" -> Right (channelName NavLinkClicked, channelSchema NavLinkClicked, channelIsScoped NavLinkClicked)
  "nav:push" -> Right (channelName NavPush, channelSchema NavPush, channelIsScoped NavPush)
  "nav:external" -> Right (channelName NavExternal, channelSchema NavExternal, channelIsScoped NavExternal)
  "beckon:hover" -> Right (channelName BeckonHover, channelSchema BeckonHover, channelIsScoped BeckonHover)
  "beckon:focus" -> Right (channelName BeckonFocus, channelSchema BeckonFocus, channelIsScoped BeckonFocus)
  "beckon:sparkle" -> Right (channelName BeckonSparkle, channelSchema BeckonSparkle, channelIsScoped BeckonSparkle)
  "job:started" -> Right (channelName JobStarted, channelSchema JobStarted, channelIsScoped JobStarted)
  "job:assigned" -> Right (channelName JobAssigned, channelSchema JobAssigned, channelIsScoped JobAssigned)
  "job:completed" -> Right (channelName JobCompleted, channelSchema JobCompleted, channelIsScoped JobCompleted)
  "job:failed" -> Right (channelName JobFailed, channelSchema JobFailed, channelIsScoped JobFailed)
  "job:start" -> Right (channelName JobStart, channelSchema JobStart, channelIsScoped JobStart)
  "job:assign" -> Right (channelName JobAssign, channelSchema JobAssign, channelIsScoped JobAssign)
  "job:report-progress" -> Right (channelName JobReportProgress, channelSchema JobReportProgress, channelIsScoped JobReportProgress)
  "job:complete" -> Right (channelName JobComplete, channelSchema JobComplete, channelIsScoped JobComplete)
  "job:fail" -> Right (channelName JobFail, channelSchema JobFail, channelIsScoped JobFail)
  "job:checkpoint" -> Right (channelName JobCheckpoint, channelSchema JobCheckpoint, channelIsScoped JobCheckpoint)
  "job:queued" -> Right (channelName JobQueued, channelSchema JobQueued, channelIsScoped JobQueued)
  "job:cancel-requested" -> Right (channelName JobCancelRequested, channelSchema JobCancelRequested, channelIsScoped JobCancelRequested)
  "job:cancel" -> Right (channelName JobCancel, channelSchema JobCancel, channelIsScoped JobCancel)
  "job:limits-requested" -> Right (channelName JobLimitsRequested, channelSchema JobLimitsRequested, channelIsScoped JobLimitsRequested)
  "job:limits-result" -> Right (channelName JobLimitsResult, channelSchema JobLimitsResult, channelIsScoped JobLimitsResult)
  "job:limits-failed" -> Right (channelName JobLimitsFailed, channelSchema JobLimitsFailed, channelIsScoped JobLimitsFailed)
  "job:status-requested" -> Right (channelName JobStatusRequested, channelSchema JobStatusRequested, channelIsScoped JobStatusRequested)
  "job:create" -> Right (channelName JobCreate, channelSchema JobCreate, channelIsScoped JobCreate)
  "job:claim" -> Right (channelName JobClaim, channelSchema JobClaim, channelIsScoped JobClaim)
  "job:status-result" -> Right (channelName JobStatusResult, channelSchema JobStatusResult, channelIsScoped JobStatusResult)
  "job:status-failed" -> Right (channelName JobStatusFailed, channelSchema JobStatusFailed, channelIsScoped JobStatusFailed)
  "job:created" -> Right (channelName JobCreated, channelSchema JobCreated, channelIsScoped JobCreated)
  "job:create-failed" -> Right (channelName JobCreateFailed, channelSchema JobCreateFailed, channelIsScoped JobCreateFailed)
  "job:claimed" -> Right (channelName JobClaimed, channelSchema JobClaimed, channelIsScoped JobClaimed)
  "job:claim-failed" -> Right (channelName JobClaimFailed, channelSchema JobClaimFailed, channelIsScoped JobClaimFailed)
  "job:cancel-ok" -> Right (channelName JobCancelOk, channelSchema JobCancelOk, channelIsScoped JobCancelOk)
  "job:cancel-failed" -> Right (channelName JobCancelFailed, channelSchema JobCancelFailed, channelIsScoped JobCancelFailed)
  "weave:applied" -> Right (channelName WeaveApplied, channelSchema WeaveApplied, channelIsScoped WeaveApplied)
  "smelt:settled" -> Right (channelName SmeltSettled, channelSchema SmeltSettled, channelIsScoped SmeltSettled)
  "weave:rebuild" -> Right (channelName WeaveRebuild, channelSchema WeaveRebuild, channelIsScoped WeaveRebuild)
  "weave:rebuild-ok" -> Right (channelName WeaveRebuildOk, channelSchema WeaveRebuildOk, channelIsScoped WeaveRebuildOk)
  "weave:rebuild-failed" -> Right (channelName WeaveRebuildFailed, channelSchema WeaveRebuildFailed, channelIsScoped WeaveRebuildFailed)
  "smelt:rebuild-anchors" -> Right (channelName SmeltRebuildAnchors, channelSchema SmeltRebuildAnchors, channelIsScoped SmeltRebuildAnchors)
  "smelt:rebuild-anchors-ok" -> Right (channelName SmeltRebuildAnchorsOk, channelSchema SmeltRebuildAnchorsOk, channelIsScoped SmeltRebuildAnchorsOk)
  "smelt:rebuild-anchors-failed" -> Right (channelName SmeltRebuildAnchorsFailed, channelSchema SmeltRebuildAnchorsFailed, channelIsScoped SmeltRebuildAnchorsFailed)
  "settings:theme-changed" -> Right (channelName SettingsThemeChanged, channelSchema SettingsThemeChanged, channelIsScoped SettingsThemeChanged)
  "settings:line-numbers-toggled" -> Right (channelName SettingsLineNumbersToggled, channelSchema SettingsLineNumbersToggled, channelIsScoped SettingsLineNumbersToggled)
  "settings:locale-changed" -> Right (channelName SettingsLocaleChanged, channelSchema SettingsLocaleChanged, channelIsScoped SettingsLocaleChanged)
  "settings:hover-delay-changed" -> Right (channelName SettingsHoverDelayChanged, channelSchema SettingsHoverDelayChanged, channelIsScoped SettingsHoverDelayChanged)
  "bus:resume-gap" -> Right (channelName BusResumeGap, channelSchema BusResumeGap, channelIsScoped BusResumeGap)
  "session:joined" -> Right (channelName SessionJoined, channelSchema SessionJoined, channelIsScoped SessionJoined)
  "session:left" -> Right (channelName SessionLeft, channelSchema SessionLeft, channelIsScoped SessionLeft)
  _ -> Left "unknown channel in metadata dispatcher"
operationMetadata :: [(Text, Text, Text)]
operationMetadata = [names BindUpdateBodyOperation, names BrowseResourceRequestedOperation, names BrowseResourcesRequestedOperation, names BrowseAnnotationRequestedOperation, names BrowseAnnotationHistoryRequestedOperation, names BrowseEventsRequestedOperation, names BrowseEntityTypesRequestedOperation, names BrowseTagSchemasRequestedOperation, names BrowseEnginesRequestedOperation, names BrowseProfilesRequestedOperation, names BrowseKbRequestedOperation, names BrowseDirectoryRequestedOperation, names FrameAddEntityTypeOperation, names FrameAddTagSchemaOperation, names GatherRequestedOperation, names GatherResourceRequestedOperation, names GatherSummaryRequestedOperation, names GatherReferencedByRequestedOperation, names GatherLimitsRequestedOperation, names JobCreateOperation, names JobStatusRequestedOperation, names JobLimitsRequestedOperation, names JobCancelRequestedOperation, names JobClaimOperation, names MarkCreateRequestOperation, names MarkCommitOperation, names MarkDeleteOperation, names MarkArchiveOperation, names MarkUnarchiveOperation, names MarkUpdateEntityTypesOperation, names MatchSearchRequestedOperation, names MatchResourcesRequestedOperation, names MatchLimitsRequestedOperation, names WeaveRebuildOperation, names SmeltRebuildAnchorsOperation, names YieldCreateOperation, names YieldClonePersistOperation, names YieldUpdateOperation, names YieldCloneCreateOperation, names YieldCloneResourceRequestedOperation, names YieldCloneTokenRequestedOperation]
  where names operation = let (asked, result, failure) = operationChannels operation in (channelName asked, channelName result, channelName failure)
