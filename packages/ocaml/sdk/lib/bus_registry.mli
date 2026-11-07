(* Generated from protocol/specs/src/bus/registry.json and its OpenAPI components. Do not edit. *)

[@@@ocamlformat "disable"]

type 'schema component
type 'schema envelope
type 'schemas recorded
type empty
type void
type delivery = Positioned | Correlated | Passing
type audience = Everyone | Scoped | Declared
type operation_effect = Reads | Writes
type payload = Component of string | Envelope of string | Recorded of { envelope : string; payload : string } | Empty | Void
type 'a decoded
type fault = { member : string; reason : [ `Lacks | `Malformed ] }
type decode_error = Invalid_json of string | Invalid_payload of fault
val encode : 'a decoded -> string
val json : 'a decoded -> Yojson.Raw.t
type 'a channel
type ('request, 'result, 'failure) operation
type packed_channel = Channel : 'a channel -> packed_channel
type packed_operation = Operation : ('request, 'result, 'failure) operation -> packed_operation
val decode : 'a channel -> string -> ('a decoded, decode_error) result
val name : 'a channel -> string
val payload : 'a channel -> payload
val delivery : 'a channel -> delivery option
val emittable : 'a channel -> bool
val audience : 'a channel -> audience option
val in_process : 'a channel -> bool
val operation_effect : ('request, 'result, 'failure) operation -> operation_effect option
val request : ('request, 'result, 'failure) operation -> 'request channel
val result : ('request, 'result, 'failure) operation -> 'result channel
val failure : ('request, 'result, 'failure) operation -> 'failure channel
val reply_names : ('request, 'result, 'failure) operation -> string list
val trace_field : string
val stream_event : string
val channels : packed_channel list
val operations : packed_operation list
module Channels : sig
  val yield_created : ([ `StoredEventResponse ] * [ `ResourceCreatedPayload ]) recorded channel
  val yield_cloned : ([ `StoredEventResponse ] * [ `ResourceClonedPayload ]) recorded channel
  val yield_updated : ([ `StoredEventResponse ] * [ `ResourceUpdatedPayload ]) recorded channel
  val yield_moved : ([ `StoredEventResponse ] * [ `ResourceMovedPayload ]) recorded channel
  val yield_representation_added : ([ `StoredEventResponse ] * [ `RepresentationAddedPayload ]) recorded channel
  val yield_representation_removed : ([ `StoredEventResponse ] * [ `RepresentationRemovedPayload ]) recorded channel
  val yield_create : [ `YieldCreateCommand ] component channel
  val yield_clone_persist : [ `YieldClonePersistCommand ] component channel
  val yield_update : [ `YieldUpdateCommand ] component channel
  val yield_clone : void channel
  val yield_clone_token_requested : [ `YieldCloneTokenRequest ] component channel
  val yield_clone_resource_requested : [ `YieldCloneResourceRequest ] component channel
  val yield_clone_create : [ `YieldCloneCreateCommand ] component channel
  val yield_create_ok : [ `YieldCreateOk ] component channel
  val yield_create_failed : [ `CommandError ] component channel
  val yield_clone_persist_ok : [ `YieldClonePersistOk ] component channel
  val yield_clone_persist_failed : [ `CommandError ] component channel
  val yield_update_ok : [ `YieldUpdateOk ] component channel
  val yield_update_failed : [ `CommandError ] component channel
  val yield_clone_token_generated : [ `CloneResourceWithTokenResponse ] envelope channel
  val yield_clone_token_failed : [ `CommandError ] component channel
  val yield_clone_resource_result : [ `GetResourceByTokenResponse ] envelope channel
  val yield_clone_resource_failed : [ `CommandError ] component channel
  val yield_clone_created : [ `YieldCloneCreated ] component channel
  val yield_clone_create_failed : [ `CommandError ] component channel
  val mark_added : ([ `EnrichedResourceEvent ] * [ `AnnotationAddedPayload ]) recorded channel
  val mark_removed : ([ `StoredEventResponse ] * [ `AnnotationRemovedPayload ]) recorded channel
  val mark_body_updated : ([ `EnrichedResourceEvent ] * [ `AnnotationBodyUpdatedPayload ]) recorded channel
  val mark_entity_tag_added : ([ `StoredEventResponse ] * [ `EntityTagChangedPayload ]) recorded channel
  val mark_entity_tag_removed : ([ `StoredEventResponse ] * [ `EntityTagChangedPayload ]) recorded channel
  val mark_archived : ([ `StoredEventResponse ] * [ `ResourceArchivedPayload ]) recorded channel
  val mark_unarchived : ([ `StoredEventResponse ] * [ `ResourceUnarchivedPayload ]) recorded channel
  val mark_create_request : [ `MarkCreateRequest ] component channel
  val mark_delete : [ `MarkDeleteCommand ] component channel
  val mark_update_body : [ `MarkUpdateBodyCommand ] component channel
  val mark_archive : [ `MarkArchiveCommand ] component channel
  val mark_unarchive : [ `MarkUnarchiveCommand ] component channel
  val mark_update_entity_types : [ `MarkUpdateEntityTypesCommand ] component channel
  val mark_create_ok : [ `MarkCreateOk ] component channel
  val mark_create_failed : [ `CommandError ] component channel
  val mark_commit : [ `MarkCommitCommand ] component channel
  val mark_commit_ok : [ `MarkCommitOk ] component channel
  val mark_commit_failed : [ `CommandError ] component channel
  val mark_delete_ok : [ `MarkDeleteOk ] component channel
  val mark_delete_failed : [ `CommandError ] component channel
  val mark_archive_ok : empty channel
  val mark_archive_failed : [ `CommandError ] component channel
  val mark_unarchive_ok : empty channel
  val mark_unarchive_failed : [ `CommandError ] component channel
  val mark_update_entity_types_ok : empty channel
  val mark_update_entity_types_failed : [ `CommandError ] component channel
  val mark_body_update_failed : [ `CommandError ] component channel
  val mark_requested : [ `MarkRequestedEvent ] component channel
  val mark_submit : [ `MarkSubmitEvent ] component channel
  val mark_delegate_timeout : [ `MarkDelegateTimeoutEvent ] component channel
  val mark_create_error : [ `ResourceErrorEvent ] component channel
  val mark_delete_error : [ `ResourceErrorEvent ] component channel
  val bind_body_error : [ `ResourceErrorEvent ] component channel
  val frame_entity_type_added : ([ `StoredEventResponse ] * [ `EntityTypeAddedPayload ]) recorded channel
  val frame_tag_schema_added : ([ `StoredEventResponse ] * [ `TagSchemaAddedPayload ]) recorded channel
  val frame_add_entity_type : [ `FrameAddEntityTypeCommand ] component channel
  val frame_add_tag_schema : [ `FrameAddTagSchemaCommand ] component channel
  val frame_entity_type_add_ok : empty channel
  val frame_entity_type_add_failed : [ `CommandError ] component channel
  val frame_tag_schema_add_ok : empty channel
  val frame_tag_schema_add_failed : [ `CommandError ] component channel
  val principal_profiled : ([ `StoredEventResponse ] * [ `PrincipalProfiledPayload ]) recorded channel
  val principal_profile : [ `PrincipalProfileCommand ] component channel
  val bind_initiate : [ `BindInitiateCommand ] component channel
  val bind_update_body : [ `BindUpdateBodyCommand ] component channel
  val bind_body_updated : [ `BindBodyUpdated ] component channel
  val bind_body_update_failed : [ `CommandError ] component channel
  val match_search_requested : [ `MatchSearchRequest ] component channel
  val match_search_results : [ `MatchSearchResult ] component channel
  val match_search_failed : [ `MatchSearchFailed ] component channel
  val match_resources_requested : [ `MatchResourcesRequest ] component channel
  val match_resources_result : [ `MatchResourcesResult ] component channel
  val match_resources_failed : [ `CommandError ] component channel
  val match_limits_requested : [ `InferenceLimitsRequest ] component channel
  val match_limits_result : [ `InferenceLimitsResult ] component channel
  val match_limits_failed : [ `CommandError ] component channel
  val gather_requested : [ `GatherAnnotationRequest ] component channel
  val gather_complete : [ `GatherAnnotationComplete ] component channel
  val gather_failed : [ `GatherFailed ] component channel
  val gather_resource_requested : [ `GatherResourceRequest ] component channel
  val gather_resource_complete : [ `GatherResourceComplete ] component channel
  val gather_resource_failed : [ `GatherResourceFailed ] component channel
  val gather_summary_requested : [ `GatherSummaryRequest ] component channel
  val gather_summary_result : [ `ContextualSummaryResponse ] envelope channel
  val gather_summary_failed : [ `CommandError ] component channel
  val gather_referenced_by_requested : [ `GatherReferencedByRequest ] component channel
  val gather_referenced_by_result : [ `GatherReferencedByResult ] component channel
  val gather_referenced_by_failed : [ `CommandError ] component channel
  val gather_limits_requested : [ `InferenceLimitsRequest ] component channel
  val gather_limits_result : [ `InferenceLimitsResult ] component channel
  val gather_limits_failed : [ `CommandError ] component channel
  val browse_resource_requested : [ `BrowseResourceRequest ] component channel
  val browse_resource_result : [ `BrowseResourceResult ] component channel
  val browse_resource_failed : [ `CommandError ] component channel
  val browse_resources_requested : [ `BrowseResourcesRequest ] component channel
  val browse_resources_result : [ `BrowseResourcesResult ] component channel
  val browse_resources_failed : [ `CommandError ] component channel
  val browse_annotation_requested : [ `BrowseAnnotationRequest ] component channel
  val browse_annotation_result : [ `BrowseAnnotationResult ] component channel
  val browse_annotation_failed : [ `CommandError ] component channel
  val browse_events_requested : [ `BrowseEventsRequest ] component channel
  val browse_events_result : [ `BrowseEventsResult ] component channel
  val browse_events_failed : [ `CommandError ] component channel
  val browse_annotation_history_requested : [ `BrowseAnnotationHistoryRequest ] component channel
  val browse_annotation_history_result : [ `BrowseAnnotationHistoryResult ] component channel
  val browse_annotation_history_failed : [ `CommandError ] component channel
  val browse_entity_types_requested : [ `BrowseEntityTypesRequest ] component channel
  val browse_entity_types_result : [ `BrowseEntityTypesResult ] component channel
  val browse_entity_types_failed : [ `CommandError ] component channel
  val browse_tag_schemas_requested : [ `BrowseTagSchemasRequest ] component channel
  val browse_tag_schemas_result : [ `BrowseTagSchemasResult ] component channel
  val browse_tag_schemas_failed : [ `CommandError ] component channel
  val browse_engines_requested : [ `BrowseEnginesRequest ] component channel
  val browse_engines_result : [ `BrowseEnginesResult ] component channel
  val browse_engines_failed : [ `CommandError ] component channel
  val browse_profiles_requested : [ `BrowseProfilesRequest ] component channel
  val browse_profiles_result : [ `BrowseProfilesResult ] component channel
  val browse_profiles_failed : [ `CommandError ] component channel
  val browse_kb_requested : [ `BrowseKbRequest ] component channel
  val browse_kb_result : [ `BrowseKbResult ] component channel
  val browse_kb_failed : [ `CommandError ] component channel
  val browse_directory_requested : [ `BrowseDirectoryRequest ] component channel
  val browse_directory_result : [ `BrowseDirectoryResult ] component channel
  val browse_directory_failed : [ `BrowseDirectoryFailed ] component channel
  val browse_click : [ `BrowseClickEvent ] component channel
  val browse_resource_open : [ `BrowseResourceOpenEvent ] component channel
  val browse_resource_viewed : [ `BrowseResourceViewedEvent ] component channel
  val browse_entity_type_clicked : [ `BrowseEntityTypeClickedEvent ] component channel
  val panel_toggle : [ `BrowsePanelToggleEvent ] component channel
  val panel_open : [ `BrowsePanelOpenEvent ] component channel
  val panel_close : void channel
  val shell_sidebar_toggle : void channel
  val tabs_close : [ `BrowseResourceCloseEvent ] component channel
  val tabs_reorder : [ `BrowseResourceReorderEvent ] component channel
  val nav_link_clicked : [ `BrowseLinkClickedEvent ] component channel
  val nav_push : [ `BrowseRouterPushEvent ] component channel
  val nav_external : [ `BrowseExternalNavigateEvent ] component channel
  val beckon_hover : [ `BeckonHoverEvent ] component channel
  val beckon_focus : [ `BeckonFocusEvent ] component channel
  val beckon_sparkle : [ `BeckonSparkleEvent ] component channel
  val job_started : ([ `StoredEventResponse ] * [ `JobStartedPayload ]) recorded channel
  val job_assigned : ([ `StoredEventResponse ] * [ `JobAssignedPayload ]) recorded channel
  val job_completed : ([ `StoredEventResponse ] * [ `JobCompletedPayload ]) recorded channel
  val job_failed : ([ `StoredEventResponse ] * [ `JobFailedPayload ]) recorded channel
  val job_start : [ `JobStartCommand ] component channel
  val job_assign : [ `JobAssignCommand ] component channel
  val job_report_progress : [ `JobReportProgressCommand ] component channel
  val job_complete : [ `JobCompleteCommand ] component channel
  val job_fail : [ `JobFailCommand ] component channel
  val job_checkpoint : [ `JobCheckpointCommand ] component channel
  val job_queued : [ `JobQueuedEvent ] component channel
  val job_cancel_requested : [ `JobCancelRequest ] component channel
  val job_cancel : [ `JobCancelCommand ] component channel
  val job_limits_requested : [ `InferenceLimitsRequest ] component channel
  val job_limits_result : [ `InferenceLimitsResult ] component channel
  val job_limits_failed : [ `CommandError ] component channel
  val job_status_requested : [ `JobStatusRequest ] component channel
  val job_create : [ `JobCreateCommand ] component channel
  val job_claim : [ `JobClaimCommand ] component channel
  val job_status_result : [ `JobStatusResult ] component channel
  val job_status_failed : [ `CommandError ] component channel
  val job_created : [ `JobCreatedResult ] component channel
  val job_create_failed : [ `CommandError ] component channel
  val job_claimed : [ `JobClaimedResult ] component channel
  val job_claim_failed : [ `CommandError ] component channel
  val job_cancel_ok : [ `JobCancelResult ] envelope channel
  val job_cancel_failed : [ `CommandError ] component channel
  val weave_applied : [ `WeaveApplied ] component channel
  val smelt_settled : [ `SmeltSettled ] component channel
  val weave_rebuild : [ `WeaveRebuildCommand ] component channel
  val weave_rebuild_ok : empty channel
  val weave_rebuild_failed : [ `CommandError ] component channel
  val smelt_rebuild_anchors : [ `SmeltRebuildAnchorsCommand ] component channel
  val smelt_rebuild_anchors_ok : empty channel
  val smelt_rebuild_anchors_failed : [ `CommandError ] component channel
  val settings_theme_changed : [ `SettingsThemeChangedEvent ] component channel
  val settings_line_numbers_toggled : void channel
  val settings_locale_changed : [ `SettingsLocaleChangedEvent ] component channel
  val settings_hover_delay_changed : [ `SettingsHoverDelayChangedEvent ] component channel
  val bus_resume_gap : [ `BusResumeGap ] component channel
  val session_joined : [ `SessionJoinedEvent ] component channel
  val session_left : [ `SessionLeftEvent ] component channel
end
module Operations : sig
  val bind_update_body : ([ `BindUpdateBodyCommand ] component, [ `BindBodyUpdated ] component, [ `CommandError ] component) operation
  val browse_resource_requested : ([ `BrowseResourceRequest ] component, [ `BrowseResourceResult ] component, [ `CommandError ] component) operation
  val browse_resources_requested : ([ `BrowseResourcesRequest ] component, [ `BrowseResourcesResult ] component, [ `CommandError ] component) operation
  val browse_annotation_requested : ([ `BrowseAnnotationRequest ] component, [ `BrowseAnnotationResult ] component, [ `CommandError ] component) operation
  val browse_annotation_history_requested : ([ `BrowseAnnotationHistoryRequest ] component, [ `BrowseAnnotationHistoryResult ] component, [ `CommandError ] component) operation
  val browse_events_requested : ([ `BrowseEventsRequest ] component, [ `BrowseEventsResult ] component, [ `CommandError ] component) operation
  val browse_entity_types_requested : ([ `BrowseEntityTypesRequest ] component, [ `BrowseEntityTypesResult ] component, [ `CommandError ] component) operation
  val browse_tag_schemas_requested : ([ `BrowseTagSchemasRequest ] component, [ `BrowseTagSchemasResult ] component, [ `CommandError ] component) operation
  val browse_engines_requested : ([ `BrowseEnginesRequest ] component, [ `BrowseEnginesResult ] component, [ `CommandError ] component) operation
  val browse_profiles_requested : ([ `BrowseProfilesRequest ] component, [ `BrowseProfilesResult ] component, [ `CommandError ] component) operation
  val browse_kb_requested : ([ `BrowseKbRequest ] component, [ `BrowseKbResult ] component, [ `CommandError ] component) operation
  val browse_directory_requested : ([ `BrowseDirectoryRequest ] component, [ `BrowseDirectoryResult ] component, [ `BrowseDirectoryFailed ] component) operation
  val frame_add_entity_type : ([ `FrameAddEntityTypeCommand ] component, empty, [ `CommandError ] component) operation
  val frame_add_tag_schema : ([ `FrameAddTagSchemaCommand ] component, empty, [ `CommandError ] component) operation
  val gather_requested : ([ `GatherAnnotationRequest ] component, [ `GatherAnnotationComplete ] component, [ `GatherFailed ] component) operation
  val gather_resource_requested : ([ `GatherResourceRequest ] component, [ `GatherResourceComplete ] component, [ `GatherResourceFailed ] component) operation
  val gather_summary_requested : ([ `GatherSummaryRequest ] component, [ `ContextualSummaryResponse ] envelope, [ `CommandError ] component) operation
  val gather_referenced_by_requested : ([ `GatherReferencedByRequest ] component, [ `GatherReferencedByResult ] component, [ `CommandError ] component) operation
  val gather_limits_requested : ([ `InferenceLimitsRequest ] component, [ `InferenceLimitsResult ] component, [ `CommandError ] component) operation
  val job_create : ([ `JobCreateCommand ] component, [ `JobCreatedResult ] component, [ `CommandError ] component) operation
  val job_status_requested : ([ `JobStatusRequest ] component, [ `JobStatusResult ] component, [ `CommandError ] component) operation
  val job_limits_requested : ([ `InferenceLimitsRequest ] component, [ `InferenceLimitsResult ] component, [ `CommandError ] component) operation
  val job_cancel_requested : ([ `JobCancelRequest ] component, [ `JobCancelResult ] envelope, [ `CommandError ] component) operation
  val job_claim : ([ `JobClaimCommand ] component, [ `JobClaimedResult ] component, [ `CommandError ] component) operation
  val mark_create_request : ([ `MarkCreateRequest ] component, [ `MarkCreateOk ] component, [ `CommandError ] component) operation
  val mark_commit : ([ `MarkCommitCommand ] component, [ `MarkCommitOk ] component, [ `CommandError ] component) operation
  val mark_delete : ([ `MarkDeleteCommand ] component, [ `MarkDeleteOk ] component, [ `CommandError ] component) operation
  val mark_archive : ([ `MarkArchiveCommand ] component, empty, [ `CommandError ] component) operation
  val mark_unarchive : ([ `MarkUnarchiveCommand ] component, empty, [ `CommandError ] component) operation
  val mark_update_entity_types : ([ `MarkUpdateEntityTypesCommand ] component, empty, [ `CommandError ] component) operation
  val match_search_requested : ([ `MatchSearchRequest ] component, [ `MatchSearchResult ] component, [ `MatchSearchFailed ] component) operation
  val match_resources_requested : ([ `MatchResourcesRequest ] component, [ `MatchResourcesResult ] component, [ `CommandError ] component) operation
  val match_limits_requested : ([ `InferenceLimitsRequest ] component, [ `InferenceLimitsResult ] component, [ `CommandError ] component) operation
  val weave_rebuild : ([ `WeaveRebuildCommand ] component, empty, [ `CommandError ] component) operation
  val smelt_rebuild_anchors : ([ `SmeltRebuildAnchorsCommand ] component, empty, [ `CommandError ] component) operation
  val yield_create : ([ `YieldCreateCommand ] component, [ `YieldCreateOk ] component, [ `CommandError ] component) operation
  val yield_clone_persist : ([ `YieldClonePersistCommand ] component, [ `YieldClonePersistOk ] component, [ `CommandError ] component) operation
  val yield_update : ([ `YieldUpdateCommand ] component, [ `YieldUpdateOk ] component, [ `CommandError ] component) operation
  val yield_clone_create : ([ `YieldCloneCreateCommand ] component, [ `YieldCloneCreated ] component, [ `CommandError ] component) operation
  val yield_clone_resource_requested : ([ `YieldCloneResourceRequest ] component, [ `GetResourceByTokenResponse ] envelope, [ `CommandError ] component) operation
  val yield_clone_token_requested : ([ `YieldCloneTokenRequest ] component, [ `CloneResourceWithTokenResponse ] envelope, [ `CommandError ] component) operation
end
