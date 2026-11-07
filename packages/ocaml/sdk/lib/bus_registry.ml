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
type 'a channel = { name : string; payload : payload; delivery : delivery option; emittable : bool; audience : audience option; in_process : bool }
type ('request, 'result, 'failure) operation = { request : 'request channel; result : 'result channel; failure : 'failure channel; reply_names : string list; operation_effect : operation_effect option }
type 'a decoded = Yojson.Raw.t
type fault = Schema_codec.fault = { member : string; reason : [ `Lacks | `Malformed ] }
type decode_error = Schema_codec.error = Invalid_json of string | Invalid_payload of fault
type packed_channel = Channel : 'a channel -> packed_channel
type packed_operation = Operation : ('request, 'result, 'failure) operation -> packed_operation
let json value = value
let encode value = Yojson.Raw.to_string value
let decode channel source =
  let open Schema_shape in
  let shape = match channel.payload with
    | Component name -> reference name
    | Recorded { envelope; payload } ->
        { any with all_of = [reference envelope; object_ ~members:["payload", reference payload] ()] }
    | Envelope name -> object_ ~required:["response"] ~members:["response", reference name] ~closed:["response"] ()
    | Empty | Void -> object_ ~closed:[] ()
  in
  Schema_codec.decode shape source
let name value = value.name
let payload value = value.payload
let delivery value = value.delivery
let emittable value = value.emittable
let audience value = value.audience
let in_process value = value.in_process
let operation_effect value = value.operation_effect
let request value = value.request
let result value = value.result
let failure value = value.failure
let reply_names value = value.reply_names
let trace_field = "_trace"
let stream_event = "bus-event"
module Channels = struct
  let yield_created = { name = "yield:created"; payload = Recorded { envelope = "StoredEventResponse"; payload = "ResourceCreatedPayload" }; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let yield_cloned = { name = "yield:cloned"; payload = Recorded { envelope = "StoredEventResponse"; payload = "ResourceClonedPayload" }; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let yield_updated = { name = "yield:updated"; payload = Recorded { envelope = "StoredEventResponse"; payload = "ResourceUpdatedPayload" }; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let yield_moved = { name = "yield:moved"; payload = Recorded { envelope = "StoredEventResponse"; payload = "ResourceMovedPayload" }; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let yield_representation_added = { name = "yield:representation-added"; payload = Recorded { envelope = "StoredEventResponse"; payload = "RepresentationAddedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let yield_representation_removed = { name = "yield:representation-removed"; payload = Recorded { envelope = "StoredEventResponse"; payload = "RepresentationRemovedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let yield_create = { name = "yield:create"; payload = Component "YieldCreateCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let yield_clone_persist = { name = "yield:clone-persist"; payload = Component "YieldClonePersistCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let yield_update = { name = "yield:update"; payload = Component "YieldUpdateCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let yield_clone = { name = "yield:clone"; payload = Void; delivery = None; emittable = false; audience = None; in_process = true }
  let yield_clone_token_requested = { name = "yield:clone-token-requested"; payload = Component "YieldCloneTokenRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let yield_clone_resource_requested = { name = "yield:clone-resource-requested"; payload = Component "YieldCloneResourceRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let yield_clone_create = { name = "yield:clone-create"; payload = Component "YieldCloneCreateCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let yield_create_ok = { name = "yield:create-ok"; payload = Component "YieldCreateOk"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let yield_create_failed = { name = "yield:create-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let yield_clone_persist_ok = { name = "yield:clone-persist-ok"; payload = Component "YieldClonePersistOk"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let yield_clone_persist_failed = { name = "yield:clone-persist-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let yield_update_ok = { name = "yield:update-ok"; payload = Component "YieldUpdateOk"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let yield_update_failed = { name = "yield:update-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let yield_clone_token_generated = { name = "yield:clone-token-generated"; payload = Envelope "CloneResourceWithTokenResponse"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let yield_clone_token_failed = { name = "yield:clone-token-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let yield_clone_resource_result = { name = "yield:clone-resource-result"; payload = Envelope "GetResourceByTokenResponse"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let yield_clone_resource_failed = { name = "yield:clone-resource-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let yield_clone_created = { name = "yield:clone-created"; payload = Component "YieldCloneCreated"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let yield_clone_create_failed = { name = "yield:clone-create-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let mark_added = { name = "mark:added"; payload = Recorded { envelope = "EnrichedResourceEvent"; payload = "AnnotationAddedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let mark_removed = { name = "mark:removed"; payload = Recorded { envelope = "StoredEventResponse"; payload = "AnnotationRemovedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let mark_body_updated = { name = "mark:body-updated"; payload = Recorded { envelope = "EnrichedResourceEvent"; payload = "AnnotationBodyUpdatedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let mark_entity_tag_added = { name = "mark:entity-tag-added"; payload = Recorded { envelope = "StoredEventResponse"; payload = "EntityTagChangedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let mark_entity_tag_removed = { name = "mark:entity-tag-removed"; payload = Recorded { envelope = "StoredEventResponse"; payload = "EntityTagChangedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let mark_archived = { name = "mark:archived"; payload = Recorded { envelope = "StoredEventResponse"; payload = "ResourceArchivedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let mark_unarchived = { name = "mark:unarchived"; payload = Recorded { envelope = "StoredEventResponse"; payload = "ResourceUnarchivedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let mark_create_request = { name = "mark:create-request"; payload = Component "MarkCreateRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let mark_delete = { name = "mark:delete"; payload = Component "MarkDeleteCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let mark_update_body = { name = "mark:update-body"; payload = Component "MarkUpdateBodyCommand"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let mark_archive = { name = "mark:archive"; payload = Component "MarkArchiveCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let mark_unarchive = { name = "mark:unarchive"; payload = Component "MarkUnarchiveCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let mark_update_entity_types = { name = "mark:update-entity-types"; payload = Component "MarkUpdateEntityTypesCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let mark_create_ok = { name = "mark:create-ok"; payload = Component "MarkCreateOk"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_create_failed = { name = "mark:create-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_commit = { name = "mark:commit"; payload = Component "MarkCommitCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let mark_commit_ok = { name = "mark:commit-ok"; payload = Component "MarkCommitOk"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_commit_failed = { name = "mark:commit-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_delete_ok = { name = "mark:delete-ok"; payload = Component "MarkDeleteOk"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_delete_failed = { name = "mark:delete-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_archive_ok = { name = "mark:archive-ok"; payload = Empty; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let mark_archive_failed = { name = "mark:archive-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_unarchive_ok = { name = "mark:unarchive-ok"; payload = Empty; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let mark_unarchive_failed = { name = "mark:unarchive-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_update_entity_types_ok = { name = "mark:update-entity-types-ok"; payload = Empty; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let mark_update_entity_types_failed = { name = "mark:update-entity-types-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let mark_body_update_failed = { name = "mark:body-update-failed"; payload = Component "CommandError"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let mark_requested = { name = "mark:requested"; payload = Component "MarkRequestedEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let mark_submit = { name = "mark:submit"; payload = Component "MarkSubmitEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let mark_delegate_timeout = { name = "mark:delegate-timeout"; payload = Component "MarkDelegateTimeoutEvent"; delivery = None; emittable = false; audience = None; in_process = true }
  let mark_create_error = { name = "mark:create-error"; payload = Component "ResourceErrorEvent"; delivery = None; emittable = false; audience = None; in_process = true }
  let mark_delete_error = { name = "mark:delete-error"; payload = Component "ResourceErrorEvent"; delivery = None; emittable = false; audience = None; in_process = true }
  let bind_body_error = { name = "bind:body-error"; payload = Component "ResourceErrorEvent"; delivery = None; emittable = false; audience = None; in_process = true }
  let frame_entity_type_added = { name = "frame:entity-type-added"; payload = Recorded { envelope = "StoredEventResponse"; payload = "EntityTypeAddedPayload" }; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let frame_tag_schema_added = { name = "frame:tag-schema-added"; payload = Recorded { envelope = "StoredEventResponse"; payload = "TagSchemaAddedPayload" }; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let frame_add_entity_type = { name = "frame:add-entity-type"; payload = Component "FrameAddEntityTypeCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let frame_add_tag_schema = { name = "frame:add-tag-schema"; payload = Component "FrameAddTagSchemaCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let frame_entity_type_add_ok = { name = "frame:entity-type-add-ok"; payload = Empty; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let frame_entity_type_add_failed = { name = "frame:entity-type-add-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let frame_tag_schema_add_ok = { name = "frame:tag-schema-add-ok"; payload = Empty; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let frame_tag_schema_add_failed = { name = "frame:tag-schema-add-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let principal_profiled = { name = "principal:profiled"; payload = Recorded { envelope = "StoredEventResponse"; payload = "PrincipalProfiledPayload" }; delivery = Some Passing; emittable = false; audience = Some Declared; in_process = false }
  let principal_profile = { name = "principal:profile"; payload = Component "PrincipalProfileCommand"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let bind_initiate = { name = "bind:initiate"; payload = Component "BindInitiateCommand"; delivery = None; emittable = true; audience = None; in_process = true }
  let bind_update_body = { name = "bind:update-body"; payload = Component "BindUpdateBodyCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let bind_body_updated = { name = "bind:body-updated"; payload = Component "BindBodyUpdated"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let bind_body_update_failed = { name = "bind:body-update-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let match_search_requested = { name = "match:search-requested"; payload = Component "MatchSearchRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let match_search_results = { name = "match:search-results"; payload = Component "MatchSearchResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let match_search_failed = { name = "match:search-failed"; payload = Component "MatchSearchFailed"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let match_resources_requested = { name = "match:resources-requested"; payload = Component "MatchResourcesRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let match_resources_result = { name = "match:resources-result"; payload = Component "MatchResourcesResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let match_resources_failed = { name = "match:resources-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let match_limits_requested = { name = "match:limits-requested"; payload = Component "InferenceLimitsRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let match_limits_result = { name = "match:limits-result"; payload = Component "InferenceLimitsResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let match_limits_failed = { name = "match:limits-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let gather_requested = { name = "gather:requested"; payload = Component "GatherAnnotationRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let gather_complete = { name = "gather:complete"; payload = Component "GatherAnnotationComplete"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let gather_failed = { name = "gather:failed"; payload = Component "GatherFailed"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let gather_resource_requested = { name = "gather:resource-requested"; payload = Component "GatherResourceRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let gather_resource_complete = { name = "gather:resource-complete"; payload = Component "GatherResourceComplete"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let gather_resource_failed = { name = "gather:resource-failed"; payload = Component "GatherResourceFailed"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let gather_summary_requested = { name = "gather:summary-requested"; payload = Component "GatherSummaryRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let gather_summary_result = { name = "gather:summary-result"; payload = Envelope "ContextualSummaryResponse"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let gather_summary_failed = { name = "gather:summary-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let gather_referenced_by_requested = { name = "gather:referenced-by-requested"; payload = Component "GatherReferencedByRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let gather_referenced_by_result = { name = "gather:referenced-by-result"; payload = Component "GatherReferencedByResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let gather_referenced_by_failed = { name = "gather:referenced-by-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let gather_limits_requested = { name = "gather:limits-requested"; payload = Component "InferenceLimitsRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let gather_limits_result = { name = "gather:limits-result"; payload = Component "InferenceLimitsResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let gather_limits_failed = { name = "gather:limits-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_resource_requested = { name = "browse:resource-requested"; payload = Component "BrowseResourceRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_resource_result = { name = "browse:resource-result"; payload = Component "BrowseResourceResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_resource_failed = { name = "browse:resource-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_resources_requested = { name = "browse:resources-requested"; payload = Component "BrowseResourcesRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_resources_result = { name = "browse:resources-result"; payload = Component "BrowseResourcesResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_resources_failed = { name = "browse:resources-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_annotation_requested = { name = "browse:annotation-requested"; payload = Component "BrowseAnnotationRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_annotation_result = { name = "browse:annotation-result"; payload = Component "BrowseAnnotationResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_annotation_failed = { name = "browse:annotation-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_events_requested = { name = "browse:events-requested"; payload = Component "BrowseEventsRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_events_result = { name = "browse:events-result"; payload = Component "BrowseEventsResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_events_failed = { name = "browse:events-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_annotation_history_requested = { name = "browse:annotation-history-requested"; payload = Component "BrowseAnnotationHistoryRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_annotation_history_result = { name = "browse:annotation-history-result"; payload = Component "BrowseAnnotationHistoryResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_annotation_history_failed = { name = "browse:annotation-history-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_entity_types_requested = { name = "browse:entity-types-requested"; payload = Component "BrowseEntityTypesRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_entity_types_result = { name = "browse:entity-types-result"; payload = Component "BrowseEntityTypesResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_entity_types_failed = { name = "browse:entity-types-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_tag_schemas_requested = { name = "browse:tag-schemas-requested"; payload = Component "BrowseTagSchemasRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_tag_schemas_result = { name = "browse:tag-schemas-result"; payload = Component "BrowseTagSchemasResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_tag_schemas_failed = { name = "browse:tag-schemas-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_engines_requested = { name = "browse:engines-requested"; payload = Component "BrowseEnginesRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_engines_result = { name = "browse:engines-result"; payload = Component "BrowseEnginesResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_engines_failed = { name = "browse:engines-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_profiles_requested = { name = "browse:profiles-requested"; payload = Component "BrowseProfilesRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_profiles_result = { name = "browse:profiles-result"; payload = Component "BrowseProfilesResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_profiles_failed = { name = "browse:profiles-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_kb_requested = { name = "browse:kb-requested"; payload = Component "BrowseKbRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_kb_result = { name = "browse:kb-result"; payload = Component "BrowseKbResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_kb_failed = { name = "browse:kb-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_directory_requested = { name = "browse:directory-requested"; payload = Component "BrowseDirectoryRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let browse_directory_result = { name = "browse:directory-result"; payload = Component "BrowseDirectoryResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let browse_directory_failed = { name = "browse:directory-failed"; payload = Component "BrowseDirectoryFailed"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let browse_click = { name = "browse:click"; payload = Component "BrowseClickEvent"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let browse_resource_open = { name = "browse:resource-open"; payload = Component "BrowseResourceOpenEvent"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let browse_resource_viewed = { name = "browse:resource-viewed"; payload = Component "BrowseResourceViewedEvent"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let browse_entity_type_clicked = { name = "browse:entity-type-clicked"; payload = Component "BrowseEntityTypeClickedEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let panel_toggle = { name = "panel:toggle"; payload = Component "BrowsePanelToggleEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let panel_open = { name = "panel:open"; payload = Component "BrowsePanelOpenEvent"; delivery = None; emittable = false; audience = None; in_process = true }
  let panel_close = { name = "panel:close"; payload = Void; delivery = None; emittable = false; audience = None; in_process = true }
  let shell_sidebar_toggle = { name = "shell:sidebar-toggle"; payload = Void; delivery = None; emittable = false; audience = None; in_process = true }
  let tabs_close = { name = "tabs:close"; payload = Component "BrowseResourceCloseEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let tabs_reorder = { name = "tabs:reorder"; payload = Component "BrowseResourceReorderEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let nav_link_clicked = { name = "nav:link-clicked"; payload = Component "BrowseLinkClickedEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let nav_push = { name = "nav:push"; payload = Component "BrowseRouterPushEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let nav_external = { name = "nav:external"; payload = Component "BrowseExternalNavigateEvent"; delivery = None; emittable = false; audience = None; in_process = true }
  let beckon_hover = { name = "beckon:hover"; payload = Component "BeckonHoverEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let beckon_focus = { name = "beckon:focus"; payload = Component "BeckonFocusEvent"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let beckon_sparkle = { name = "beckon:sparkle"; payload = Component "BeckonSparkleEvent"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let job_started = { name = "job:started"; payload = Recorded { envelope = "StoredEventResponse"; payload = "JobStartedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let job_assigned = { name = "job:assigned"; payload = Recorded { envelope = "StoredEventResponse"; payload = "JobAssignedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let job_completed = { name = "job:completed"; payload = Recorded { envelope = "StoredEventResponse"; payload = "JobCompletedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let job_failed = { name = "job:failed"; payload = Recorded { envelope = "StoredEventResponse"; payload = "JobFailedPayload" }; delivery = Some Positioned; emittable = false; audience = Some Scoped; in_process = false }
  let job_start = { name = "job:start"; payload = Component "JobStartCommand"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let job_assign = { name = "job:assign"; payload = Component "JobAssignCommand"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let job_report_progress = { name = "job:report-progress"; payload = Component "JobReportProgressCommand"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let job_complete = { name = "job:complete"; payload = Component "JobCompleteCommand"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let job_fail = { name = "job:fail"; payload = Component "JobFailCommand"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let job_checkpoint = { name = "job:checkpoint"; payload = Component "JobCheckpointCommand"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let job_queued = { name = "job:queued"; payload = Component "JobQueuedEvent"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let job_cancel_requested = { name = "job:cancel-requested"; payload = Component "JobCancelRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let job_cancel = { name = "job:cancel"; payload = Component "JobCancelCommand"; delivery = Some Passing; emittable = true; audience = Some Declared; in_process = false }
  let job_limits_requested = { name = "job:limits-requested"; payload = Component "InferenceLimitsRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let job_limits_result = { name = "job:limits-result"; payload = Component "InferenceLimitsResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let job_limits_failed = { name = "job:limits-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let job_status_requested = { name = "job:status-requested"; payload = Component "JobStatusRequest"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let job_create = { name = "job:create"; payload = Component "JobCreateCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let job_claim = { name = "job:claim"; payload = Component "JobClaimCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let job_status_result = { name = "job:status-result"; payload = Component "JobStatusResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let job_status_failed = { name = "job:status-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let job_created = { name = "job:created"; payload = Component "JobCreatedResult"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let job_create_failed = { name = "job:create-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let job_claimed = { name = "job:claimed"; payload = Component "JobClaimedResult"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let job_claim_failed = { name = "job:claim-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let job_cancel_ok = { name = "job:cancel-ok"; payload = Envelope "JobCancelResult"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let job_cancel_failed = { name = "job:cancel-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = true; audience = None; in_process = false }
  let weave_applied = { name = "weave:applied"; payload = Component "WeaveApplied"; delivery = Some Passing; emittable = false; audience = Some Declared; in_process = false }
  let smelt_settled = { name = "smelt:settled"; payload = Component "SmeltSettled"; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let weave_rebuild = { name = "weave:rebuild"; payload = Component "WeaveRebuildCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let weave_rebuild_ok = { name = "weave:rebuild-ok"; payload = Empty; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let weave_rebuild_failed = { name = "weave:rebuild-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let smelt_rebuild_anchors = { name = "smelt:rebuild-anchors"; payload = Component "SmeltRebuildAnchorsCommand"; delivery = Some Passing; emittable = true; audience = None; in_process = false }
  let smelt_rebuild_anchors_ok = { name = "smelt:rebuild-anchors-ok"; payload = Empty; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let smelt_rebuild_anchors_failed = { name = "smelt:rebuild-anchors-failed"; payload = Component "CommandError"; delivery = Some Correlated; emittable = false; audience = None; in_process = false }
  let settings_theme_changed = { name = "settings:theme-changed"; payload = Component "SettingsThemeChangedEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let settings_line_numbers_toggled = { name = "settings:line-numbers-toggled"; payload = Void; delivery = None; emittable = false; audience = None; in_process = true }
  let settings_locale_changed = { name = "settings:locale-changed"; payload = Component "SettingsLocaleChangedEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let settings_hover_delay_changed = { name = "settings:hover-delay-changed"; payload = Component "SettingsHoverDelayChangedEvent"; delivery = None; emittable = true; audience = None; in_process = true }
  let bus_resume_gap = { name = "bus:resume-gap"; payload = Component "BusResumeGap"; delivery = Some Passing; emittable = false; audience = Some Everyone; in_process = false }
  let session_joined = { name = "session:joined"; payload = Component "SessionJoinedEvent"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
  let session_left = { name = "session:left"; payload = Component "SessionLeftEvent"; delivery = Some Passing; emittable = true; audience = Some Everyone; in_process = false }
end
module Operations = struct
  let bind_update_body = { request = Channels.bind_update_body; result = Channels.bind_body_updated; failure = Channels.bind_body_update_failed; reply_names = []; operation_effect = Some Writes }
  let browse_resource_requested = { request = Channels.browse_resource_requested; result = Channels.browse_resource_result; failure = Channels.browse_resource_failed; reply_names = []; operation_effect = Some Reads }
  let browse_resources_requested = { request = Channels.browse_resources_requested; result = Channels.browse_resources_result; failure = Channels.browse_resources_failed; reply_names = []; operation_effect = Some Reads }
  let browse_annotation_requested = { request = Channels.browse_annotation_requested; result = Channels.browse_annotation_result; failure = Channels.browse_annotation_failed; reply_names = []; operation_effect = Some Reads }
  let browse_annotation_history_requested = { request = Channels.browse_annotation_history_requested; result = Channels.browse_annotation_history_result; failure = Channels.browse_annotation_history_failed; reply_names = []; operation_effect = Some Reads }
  let browse_events_requested = { request = Channels.browse_events_requested; result = Channels.browse_events_result; failure = Channels.browse_events_failed; reply_names = []; operation_effect = Some Reads }
  let browse_entity_types_requested = { request = Channels.browse_entity_types_requested; result = Channels.browse_entity_types_result; failure = Channels.browse_entity_types_failed; reply_names = []; operation_effect = Some Reads }
  let browse_tag_schemas_requested = { request = Channels.browse_tag_schemas_requested; result = Channels.browse_tag_schemas_result; failure = Channels.browse_tag_schemas_failed; reply_names = []; operation_effect = Some Reads }
  let browse_engines_requested = { request = Channels.browse_engines_requested; result = Channels.browse_engines_result; failure = Channels.browse_engines_failed; reply_names = []; operation_effect = Some Reads }
  let browse_profiles_requested = { request = Channels.browse_profiles_requested; result = Channels.browse_profiles_result; failure = Channels.browse_profiles_failed; reply_names = []; operation_effect = Some Reads }
  let browse_kb_requested = { request = Channels.browse_kb_requested; result = Channels.browse_kb_result; failure = Channels.browse_kb_failed; reply_names = []; operation_effect = Some Reads }
  let browse_directory_requested = { request = Channels.browse_directory_requested; result = Channels.browse_directory_result; failure = Channels.browse_directory_failed; reply_names = []; operation_effect = Some Reads }
  let frame_add_entity_type = { request = Channels.frame_add_entity_type; result = Channels.frame_entity_type_add_ok; failure = Channels.frame_entity_type_add_failed; reply_names = []; operation_effect = Some Writes }
  let frame_add_tag_schema = { request = Channels.frame_add_tag_schema; result = Channels.frame_tag_schema_add_ok; failure = Channels.frame_tag_schema_add_failed; reply_names = []; operation_effect = Some Writes }
  let gather_requested = { request = Channels.gather_requested; result = Channels.gather_complete; failure = Channels.gather_failed; reply_names = ["annotationId"]; operation_effect = Some Reads }
  let gather_resource_requested = { request = Channels.gather_resource_requested; result = Channels.gather_resource_complete; failure = Channels.gather_resource_failed; reply_names = ["resourceId"]; operation_effect = Some Reads }
  let gather_summary_requested = { request = Channels.gather_summary_requested; result = Channels.gather_summary_result; failure = Channels.gather_summary_failed; reply_names = []; operation_effect = Some Reads }
  let gather_referenced_by_requested = { request = Channels.gather_referenced_by_requested; result = Channels.gather_referenced_by_result; failure = Channels.gather_referenced_by_failed; reply_names = []; operation_effect = Some Reads }
  let gather_limits_requested = { request = Channels.gather_limits_requested; result = Channels.gather_limits_result; failure = Channels.gather_limits_failed; reply_names = []; operation_effect = Some Reads }
  let job_create = { request = Channels.job_create; result = Channels.job_created; failure = Channels.job_create_failed; reply_names = []; operation_effect = Some Writes }
  let job_status_requested = { request = Channels.job_status_requested; result = Channels.job_status_result; failure = Channels.job_status_failed; reply_names = []; operation_effect = Some Reads }
  let job_limits_requested = { request = Channels.job_limits_requested; result = Channels.job_limits_result; failure = Channels.job_limits_failed; reply_names = []; operation_effect = Some Reads }
  let job_cancel_requested = { request = Channels.job_cancel_requested; result = Channels.job_cancel_ok; failure = Channels.job_cancel_failed; reply_names = []; operation_effect = Some Writes }
  let job_claim = { request = Channels.job_claim; result = Channels.job_claimed; failure = Channels.job_claim_failed; reply_names = []; operation_effect = Some Writes }
  let mark_create_request = { request = Channels.mark_create_request; result = Channels.mark_create_ok; failure = Channels.mark_create_failed; reply_names = []; operation_effect = Some Writes }
  let mark_commit = { request = Channels.mark_commit; result = Channels.mark_commit_ok; failure = Channels.mark_commit_failed; reply_names = []; operation_effect = Some Writes }
  let mark_delete = { request = Channels.mark_delete; result = Channels.mark_delete_ok; failure = Channels.mark_delete_failed; reply_names = []; operation_effect = Some Writes }
  let mark_archive = { request = Channels.mark_archive; result = Channels.mark_archive_ok; failure = Channels.mark_archive_failed; reply_names = []; operation_effect = Some Writes }
  let mark_unarchive = { request = Channels.mark_unarchive; result = Channels.mark_unarchive_ok; failure = Channels.mark_unarchive_failed; reply_names = []; operation_effect = Some Writes }
  let mark_update_entity_types = { request = Channels.mark_update_entity_types; result = Channels.mark_update_entity_types_ok; failure = Channels.mark_update_entity_types_failed; reply_names = []; operation_effect = Some Writes }
  let match_search_requested = { request = Channels.match_search_requested; result = Channels.match_search_results; failure = Channels.match_search_failed; reply_names = ["referenceId"]; operation_effect = Some Reads }
  let match_resources_requested = { request = Channels.match_resources_requested; result = Channels.match_resources_result; failure = Channels.match_resources_failed; reply_names = []; operation_effect = Some Reads }
  let match_limits_requested = { request = Channels.match_limits_requested; result = Channels.match_limits_result; failure = Channels.match_limits_failed; reply_names = []; operation_effect = Some Reads }
  let weave_rebuild = { request = Channels.weave_rebuild; result = Channels.weave_rebuild_ok; failure = Channels.weave_rebuild_failed; reply_names = []; operation_effect = Some Writes }
  let smelt_rebuild_anchors = { request = Channels.smelt_rebuild_anchors; result = Channels.smelt_rebuild_anchors_ok; failure = Channels.smelt_rebuild_anchors_failed; reply_names = []; operation_effect = Some Writes }
  let yield_create = { request = Channels.yield_create; result = Channels.yield_create_ok; failure = Channels.yield_create_failed; reply_names = []; operation_effect = Some Writes }
  let yield_clone_persist = { request = Channels.yield_clone_persist; result = Channels.yield_clone_persist_ok; failure = Channels.yield_clone_persist_failed; reply_names = []; operation_effect = Some Writes }
  let yield_update = { request = Channels.yield_update; result = Channels.yield_update_ok; failure = Channels.yield_update_failed; reply_names = []; operation_effect = Some Writes }
  let yield_clone_create = { request = Channels.yield_clone_create; result = Channels.yield_clone_created; failure = Channels.yield_clone_create_failed; reply_names = []; operation_effect = Some Writes }
  let yield_clone_resource_requested = { request = Channels.yield_clone_resource_requested; result = Channels.yield_clone_resource_result; failure = Channels.yield_clone_resource_failed; reply_names = []; operation_effect = Some Reads }
  let yield_clone_token_requested = { request = Channels.yield_clone_token_requested; result = Channels.yield_clone_token_generated; failure = Channels.yield_clone_token_failed; reply_names = []; operation_effect = Some Reads }
end
let channels = [Channel Channels.yield_created; Channel Channels.yield_cloned; Channel Channels.yield_updated; Channel Channels.yield_moved; Channel Channels.yield_representation_added; Channel Channels.yield_representation_removed; Channel Channels.yield_create; Channel Channels.yield_clone_persist; Channel Channels.yield_update; Channel Channels.yield_clone; Channel Channels.yield_clone_token_requested; Channel Channels.yield_clone_resource_requested; Channel Channels.yield_clone_create; Channel Channels.yield_create_ok; Channel Channels.yield_create_failed; Channel Channels.yield_clone_persist_ok; Channel Channels.yield_clone_persist_failed; Channel Channels.yield_update_ok; Channel Channels.yield_update_failed; Channel Channels.yield_clone_token_generated; Channel Channels.yield_clone_token_failed; Channel Channels.yield_clone_resource_result; Channel Channels.yield_clone_resource_failed; Channel Channels.yield_clone_created; Channel Channels.yield_clone_create_failed; Channel Channels.mark_added; Channel Channels.mark_removed; Channel Channels.mark_body_updated; Channel Channels.mark_entity_tag_added; Channel Channels.mark_entity_tag_removed; Channel Channels.mark_archived; Channel Channels.mark_unarchived; Channel Channels.mark_create_request; Channel Channels.mark_delete; Channel Channels.mark_update_body; Channel Channels.mark_archive; Channel Channels.mark_unarchive; Channel Channels.mark_update_entity_types; Channel Channels.mark_create_ok; Channel Channels.mark_create_failed; Channel Channels.mark_commit; Channel Channels.mark_commit_ok; Channel Channels.mark_commit_failed; Channel Channels.mark_delete_ok; Channel Channels.mark_delete_failed; Channel Channels.mark_archive_ok; Channel Channels.mark_archive_failed; Channel Channels.mark_unarchive_ok; Channel Channels.mark_unarchive_failed; Channel Channels.mark_update_entity_types_ok; Channel Channels.mark_update_entity_types_failed; Channel Channels.mark_body_update_failed; Channel Channels.mark_requested; Channel Channels.mark_submit; Channel Channels.mark_delegate_timeout; Channel Channels.mark_create_error; Channel Channels.mark_delete_error; Channel Channels.bind_body_error; Channel Channels.frame_entity_type_added; Channel Channels.frame_tag_schema_added; Channel Channels.frame_add_entity_type; Channel Channels.frame_add_tag_schema; Channel Channels.frame_entity_type_add_ok; Channel Channels.frame_entity_type_add_failed; Channel Channels.frame_tag_schema_add_ok; Channel Channels.frame_tag_schema_add_failed; Channel Channels.principal_profiled; Channel Channels.principal_profile; Channel Channels.bind_initiate; Channel Channels.bind_update_body; Channel Channels.bind_body_updated; Channel Channels.bind_body_update_failed; Channel Channels.match_search_requested; Channel Channels.match_search_results; Channel Channels.match_search_failed; Channel Channels.match_resources_requested; Channel Channels.match_resources_result; Channel Channels.match_resources_failed; Channel Channels.match_limits_requested; Channel Channels.match_limits_result; Channel Channels.match_limits_failed; Channel Channels.gather_requested; Channel Channels.gather_complete; Channel Channels.gather_failed; Channel Channels.gather_resource_requested; Channel Channels.gather_resource_complete; Channel Channels.gather_resource_failed; Channel Channels.gather_summary_requested; Channel Channels.gather_summary_result; Channel Channels.gather_summary_failed; Channel Channels.gather_referenced_by_requested; Channel Channels.gather_referenced_by_result; Channel Channels.gather_referenced_by_failed; Channel Channels.gather_limits_requested; Channel Channels.gather_limits_result; Channel Channels.gather_limits_failed; Channel Channels.browse_resource_requested; Channel Channels.browse_resource_result; Channel Channels.browse_resource_failed; Channel Channels.browse_resources_requested; Channel Channels.browse_resources_result; Channel Channels.browse_resources_failed; Channel Channels.browse_annotation_requested; Channel Channels.browse_annotation_result; Channel Channels.browse_annotation_failed; Channel Channels.browse_events_requested; Channel Channels.browse_events_result; Channel Channels.browse_events_failed; Channel Channels.browse_annotation_history_requested; Channel Channels.browse_annotation_history_result; Channel Channels.browse_annotation_history_failed; Channel Channels.browse_entity_types_requested; Channel Channels.browse_entity_types_result; Channel Channels.browse_entity_types_failed; Channel Channels.browse_tag_schemas_requested; Channel Channels.browse_tag_schemas_result; Channel Channels.browse_tag_schemas_failed; Channel Channels.browse_engines_requested; Channel Channels.browse_engines_result; Channel Channels.browse_engines_failed; Channel Channels.browse_profiles_requested; Channel Channels.browse_profiles_result; Channel Channels.browse_profiles_failed; Channel Channels.browse_kb_requested; Channel Channels.browse_kb_result; Channel Channels.browse_kb_failed; Channel Channels.browse_directory_requested; Channel Channels.browse_directory_result; Channel Channels.browse_directory_failed; Channel Channels.browse_click; Channel Channels.browse_resource_open; Channel Channels.browse_resource_viewed; Channel Channels.browse_entity_type_clicked; Channel Channels.panel_toggle; Channel Channels.panel_open; Channel Channels.panel_close; Channel Channels.shell_sidebar_toggle; Channel Channels.tabs_close; Channel Channels.tabs_reorder; Channel Channels.nav_link_clicked; Channel Channels.nav_push; Channel Channels.nav_external; Channel Channels.beckon_hover; Channel Channels.beckon_focus; Channel Channels.beckon_sparkle; Channel Channels.job_started; Channel Channels.job_assigned; Channel Channels.job_completed; Channel Channels.job_failed; Channel Channels.job_start; Channel Channels.job_assign; Channel Channels.job_report_progress; Channel Channels.job_complete; Channel Channels.job_fail; Channel Channels.job_checkpoint; Channel Channels.job_queued; Channel Channels.job_cancel_requested; Channel Channels.job_cancel; Channel Channels.job_limits_requested; Channel Channels.job_limits_result; Channel Channels.job_limits_failed; Channel Channels.job_status_requested; Channel Channels.job_create; Channel Channels.job_claim; Channel Channels.job_status_result; Channel Channels.job_status_failed; Channel Channels.job_created; Channel Channels.job_create_failed; Channel Channels.job_claimed; Channel Channels.job_claim_failed; Channel Channels.job_cancel_ok; Channel Channels.job_cancel_failed; Channel Channels.weave_applied; Channel Channels.smelt_settled; Channel Channels.weave_rebuild; Channel Channels.weave_rebuild_ok; Channel Channels.weave_rebuild_failed; Channel Channels.smelt_rebuild_anchors; Channel Channels.smelt_rebuild_anchors_ok; Channel Channels.smelt_rebuild_anchors_failed; Channel Channels.settings_theme_changed; Channel Channels.settings_line_numbers_toggled; Channel Channels.settings_locale_changed; Channel Channels.settings_hover_delay_changed; Channel Channels.bus_resume_gap; Channel Channels.session_joined; Channel Channels.session_left]
let operations = [Operation Operations.bind_update_body; Operation Operations.browse_resource_requested; Operation Operations.browse_resources_requested; Operation Operations.browse_annotation_requested; Operation Operations.browse_annotation_history_requested; Operation Operations.browse_events_requested; Operation Operations.browse_entity_types_requested; Operation Operations.browse_tag_schemas_requested; Operation Operations.browse_engines_requested; Operation Operations.browse_profiles_requested; Operation Operations.browse_kb_requested; Operation Operations.browse_directory_requested; Operation Operations.frame_add_entity_type; Operation Operations.frame_add_tag_schema; Operation Operations.gather_requested; Operation Operations.gather_resource_requested; Operation Operations.gather_summary_requested; Operation Operations.gather_referenced_by_requested; Operation Operations.gather_limits_requested; Operation Operations.job_create; Operation Operations.job_status_requested; Operation Operations.job_limits_requested; Operation Operations.job_cancel_requested; Operation Operations.job_claim; Operation Operations.mark_create_request; Operation Operations.mark_commit; Operation Operations.mark_delete; Operation Operations.mark_archive; Operation Operations.mark_unarchive; Operation Operations.mark_update_entity_types; Operation Operations.match_search_requested; Operation Operations.match_resources_requested; Operation Operations.match_limits_requested; Operation Operations.weave_rebuild; Operation Operations.smelt_rebuild_anchors; Operation Operations.yield_create; Operation Operations.yield_clone_persist; Operation Operations.yield_update; Operation Operations.yield_clone_create; Operation Operations.yield_clone_resource_requested; Operation Operations.yield_clone_token_requested]
