(* Generated from OpenAPI object components and discriminator mappings. Do not edit. *)

[@@@ocamlformat "disable"]

module Agent_organization : sig
  type t = { field_type : string; field_id : string Types.presence; name : string; homepage : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AgentOrganization ] Models.t -> t
end
module Agent_person : sig
  type t = { field_type : string; field_id : string Types.presence; name : string Types.presence; nickname : string Types.presence; email : string Types.presence; email_sha1 : string Types.presence; homepage : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AgentPerson ] Models.t -> t
end
module Agent_software : sig
  type t = { field_type : string; field_id : string Types.presence; name : string Types.presence; provider : string Types.presence; model : string Types.presence; parameters : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AgentSoftware ] Models.t -> t
end
module Annotation : sig
  type t = { field_context : string; type_ : string; id : Yojson.Raw.t; motivation : Yojson.Raw.t; target : Yojson.Raw.t; body : Yojson.Raw.t Types.presence; creator : Yojson.Raw.t Types.presence; created : string; modified : string Types.presence; generator : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `Annotation ] Models.t -> t
end
module Annotation_added_payload : sig
  type t = { annotation : Yojson.Raw.t; content_checksum : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnnotationAddedPayload ] Models.t -> t
end
module Annotation_body_updated_payload : sig
  type t = { annotation_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnnotationBodyUpdatedPayload ] Models.t -> t
end
module Annotation_removed_payload : sig
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnnotationRemovedPayload ] Models.t -> t
end
module Annotation_target : sig
  type t = { type_ : string Types.presence; source : Yojson.Raw.t; selector : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnnotationTarget ] Models.t -> t
end
module Attributed_event : sig
  type t = { id : string; type_ : string; timestamp : string; user_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; version : Yojson.Raw.t; payload : Yojson.Raw.t; metadata : Yojson.Raw.t; agent : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AttributedEvent ] Models.t -> t
end
module Beckon_focus_event : sig
  type t = { annotation_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BeckonFocusEvent ] Models.t -> t
end
module Beckon_hover_event : sig
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BeckonHoverEvent ] Models.t -> t
end
module Beckon_sparkle_event : sig
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BeckonSparkleEvent ] Models.t -> t
end
module Bind_body_operation : sig
  type t = { op : string; item : Yojson.Raw.t Types.presence; old_item : Yojson.Raw.t Types.presence; new_item : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BindBodyOperation ] Models.t -> t
end
module Bind_initiate_command : sig
  type t = { annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; default_title : string; entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BindInitiateCommand ] Models.t -> t
end
module Bind_update_body_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BindUpdateBodyCommand ] Models.t -> t
end
module Body_operation_add : sig
  type t = { op : string; item : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BodyOperationAdd ] Models.t -> t
end
module Body_operation_remove : sig
  type t = { op : string; item : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BodyOperationRemove ] Models.t -> t
end
module Body_operation_replace : sig
  type t = { op : string; old_item : Yojson.Raw.t; new_item : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BodyOperationReplace ] Models.t -> t
end
module Browse_engines_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseEnginesResult ] Models.t -> t
end
module Browse_profiles_request : sig
  type t = { dids : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseProfilesRequest ] Models.t -> t
end
module Browse_profiles_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseProfilesResult ] Models.t -> t
end
module Browse_annotation_history_request : sig
  type t = { resource_id : Yojson.Raw.t; annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseAnnotationHistoryRequest ] Models.t -> t
end
module Browse_annotation_history_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseAnnotationHistoryResult ] Models.t -> t
end
module Browse_annotation_request : sig
  type t = { resource_id : Yojson.Raw.t; annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseAnnotationRequest ] Models.t -> t
end
module Browse_annotation_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseAnnotationResult ] Models.t -> t
end
module Browse_click_event : sig
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseClickEvent ] Models.t -> t
end
module Browse_directory_request : sig
  type t = { path : string; sort : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseDirectoryRequest ] Models.t -> t
end
module Browse_directory_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseDirectoryResult ] Models.t -> t
end
module Browse_directory_result_response : sig
  type t = { path : string; entries : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseDirectoryResultResponse ] Models.t -> t
end
module Browse_entity_type_clicked_event : sig
  type t = { entity_type : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseEntityTypeClickedEvent ] Models.t -> t
end
module Browse_entity_types_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseEntityTypesResult ] Models.t -> t
end
module Browse_events_request : sig
  type t = { resource_id : Yojson.Raw.t; type_ : string Types.presence; user_id : Yojson.Raw.t Types.presence; limit : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseEventsRequest ] Models.t -> t
end
module Browse_events_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseEventsResult ] Models.t -> t
end
module Browse_external_navigate_event : sig
  type t = { url : string; resource_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseExternalNavigateEvent ] Models.t -> t
end
module Browse_files_response : sig
  type t = { path : string; entries : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseFilesResponse ] Models.t -> t
end
module Browse_kb_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseKbResult ] Models.t -> t
end
module Browse_link_clicked_event : sig
  type t = { href : string; label : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseLinkClickedEvent ] Models.t -> t
end
module Browse_panel_open_event : sig
  type t = { panel : string; scroll_to_annotation_id : Yojson.Raw.t Types.presence; motivation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowsePanelOpenEvent ] Models.t -> t
end
module Browse_panel_toggle_event : sig
  type t = { panel : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowsePanelToggleEvent ] Models.t -> t
end
module Browse_resource_open_event : sig
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourceOpenEvent ] Models.t -> t
end
module Browse_resource_viewed_event : sig
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourceViewedEvent ] Models.t -> t
end
module Browse_resource_close_event : sig
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourceCloseEvent ] Models.t -> t
end
module Browse_resource_reorder_event : sig
  type t = { old_index : Yojson.Raw.t; new_index : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourceReorderEvent ] Models.t -> t
end
module Anchored_text : sig
  type t = { text : string; items : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnchoredText ] Models.t -> t
end
module Pdf_text_item : sig
  type t = { start : Yojson.Raw.t; end_ : Yojson.Raw.t; page : Yojson.Raw.t; x : Yojson.Raw.t; y : Yojson.Raw.t; width : Yojson.Raw.t; height : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `PdfTextItem ] Models.t -> t
end
module Anchored_text_absent : sig
  type t = { kind : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnchoredTextAbsent ] Models.t -> t
end
module Browse_resource_request : sig
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourceRequest ] Models.t -> t
end
module Browse_resource_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourceResult ] Models.t -> t
end
module Browse_resources_request : sig
  type t = { archived : bool Types.presence; entity_type : string Types.presence; offset : Yojson.Raw.t Types.presence; limit : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourcesRequest ] Models.t -> t
end
module Browse_resources_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseResourcesResult ] Models.t -> t
end
module Browse_router_push_event : sig
  type t = { path : string; reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseRouterPushEvent ] Models.t -> t
end
module Browse_tag_schemas_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseTagSchemasResult ] Models.t -> t
end
module Bus_emit_accepted : sig
  type t = { subscribers : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BusEmitAccepted ] Models.t -> t
end
module Bus_emit_request : sig
  type t = { channel : string; payload : Yojson.Raw.t; scope : Yojson.Raw.t Types.presence; client_id : string Types.presence; correlation_id : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BusEmitRequest ] Models.t -> t
end
module Bus_subscribe_request : sig
  type t = { global : Yojson.Raw.t Types.presence; pending_replies : Yojson.Raw.t Types.presence; scoped : Yojson.Raw.t Types.presence; client_id : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BusSubscribeRequest ] Models.t -> t
end
module Clone_resource_with_token_response : sig
  type t = { token : string; expires_at : string; resource : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `CloneResourceWithTokenResponse ] Models.t -> t
end
module Engine_entry : sig
  type t = { engine : Yojson.Raw.t; jobs : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `EngineEntry ] Models.t -> t
end
module Command_error : sig
  type t = { code : string Types.presence; message : string; details : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `CommandError ] Models.t -> t
end
module Contextual_summary_response : sig
  type t = { summary : string; relevant_fields : Yojson.Raw.t; context : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ContextualSummaryResponse ] Models.t -> t
end
module Create_annotation_request : sig
  type t = { motivation : Yojson.Raw.t; target : Yojson.Raw.t; body : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `CreateAnnotationRequest ] Models.t -> t
end
module Create_resource_response : sig
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `CreateResourceResponse ] Models.t -> t
end
module Dir_entry : sig
  type t = { type_ : string; name : string; path : string; mtime : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `DirEntry ] Models.t -> t
end
module Discovered_kb : sig
  type t = { host : string; port : Yojson.Raw.t; placement : string; repo : string Types.presence; did : string; site_name : string Types.presence; managed_by : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `DiscoveredKB ] Models.t -> t
end
module Discovery_document : sig
  type t = { version : Yojson.Raw.t; kbs : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `DiscoveryDocument ] Models.t -> t
end
module Enriched_resource_event : sig
  type t = { id : string; type_ : string; timestamp : string; user_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; version : Yojson.Raw.t; payload : Yojson.Raw.t; metadata : Yojson.Raw.t; annotation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `EnrichedResourceEvent ] Models.t -> t
end
module Entity_tag_changed_payload : sig
  type t = { entity_type : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `EntityTagChangedPayload ] Models.t -> t
end
module Entity_type_added_payload : sig
  type t = { entity_type : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `EntityTypeAddedPayload ] Models.t -> t
end
module Error_response : sig
  type t = { error : string; code : string Types.presence; hint : string Types.presence; details : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ErrorResponse ] Models.t -> t
end
module Event_metadata : sig
  type t = { sequence_number : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `EventMetadata ] Models.t -> t
end
module Extracted_text : sig
  type t = { text : string; items : Yojson.Raw.t; kind : string; method_ : string; pdf_class : string Types.presence; ocr_confidence : Yojson.Raw.t Types.presence; unread_pages : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ExtractedText ] Models.t -> t
end
module Extraction_declined : sig
  type t = { kind : string; declined : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ExtractionDeclined ] Models.t -> t
end
module File_entry : sig
  type t = { type_ : string; name : string; path : string; size : Yojson.Raw.t; mtime : string; tracked : bool; resource_id : Yojson.Raw.t Types.presence; entity_types : Yojson.Raw.t Types.presence; annotation_count : Yojson.Raw.t Types.presence; creator : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `FileEntry ] Models.t -> t
end
module Fragment_selector : sig
  type t = { type_ : string; value : string; conforms_to : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `FragmentSelector ] Models.t -> t
end
module Frame_add_entity_type_command : sig
  type t = { tag : string; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `FrameAddEntityTypeCommand ] Models.t -> t
end
module Frame_add_tag_schema_command : sig
  type t = { schema : Yojson.Raw.t; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `FrameAddTagSchemaCommand ] Models.t -> t
end
module Gather_annotation_complete : sig
  type t = { annotation_id : Yojson.Raw.t; response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherAnnotationComplete ] Models.t -> t
end
module Gather_annotation_options : sig
  type t = { include_source_context : bool Types.presence; include_target_context : bool Types.presence; context_window : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherAnnotationOptions ] Models.t -> t
end
module Gather_annotation_request : sig
  type t = { annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; options : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherAnnotationRequest ] Models.t -> t
end
module Gather_resource_complete : sig
  type t = { resource_id : Yojson.Raw.t; response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherResourceComplete ] Models.t -> t
end
module Gather_resource_request : sig
  type t = { resource_id : Yojson.Raw.t; options : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherResourceRequest ] Models.t -> t
end
module Gather_resource_request_options : sig
  type t = { depth : Yojson.Raw.t; max_resources : Yojson.Raw.t; include_content : bool; include_summary : bool; exclude_entity_types : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherResourceRequestOptions ] Models.t -> t
end
module Gather_summary_request : sig
  type t = { annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherSummaryRequest ] Models.t -> t
end
module Gather_referenced_by_request : sig
  type t = { resource_id : Yojson.Raw.t; motivation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherReferencedByRequest ] Models.t -> t
end
module Gather_referenced_by_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherReferencedByResult ] Models.t -> t
end
module Gathered_context : sig
  type t = { focus : Yojson.Raw.t; graph : Yojson.Raw.t; semantic_context : Yojson.Raw.t Types.presence; metadata : Yojson.Raw.t; inferred_relationship_summary : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatheredContext ] Models.t -> t
end
module Generation_job_params : sig
  type t = { title : string; storage_uri : string; prompt : string Types.presence; entity_types : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; temperature : Yojson.Raw.t Types.presence; max_tokens : Yojson.Raw.t Types.presence; output_media_type : Yojson.Raw.t Types.presence; task : string Types.presence; structure : string Types.presence; cite : bool Types.presence; context : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GenerationJobParams ] Models.t -> t
end
module Get_annotation_history_response : sig
  type t = { events : Yojson.Raw.t; total : Yojson.Raw.t; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetAnnotationHistoryResponse ] Models.t -> t
end
module Get_annotation_response : sig
  type t = { annotation : Yojson.Raw.t; resource : Yojson.Raw.t; resolved_resource : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetAnnotationResponse ] Models.t -> t
end
module Get_annotations_response : sig
  type t = { annotations : Yojson.Raw.t; total : Yojson.Raw.t; motivation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetAnnotationsResponse ] Models.t -> t
end
module Get_entity_types_response : sig
  type t = { entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetEntityTypesResponse ] Models.t -> t
end
module Get_events_response : sig
  type t = { events : Yojson.Raw.t; total : Yojson.Raw.t; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetEventsResponse ] Models.t -> t
end
module Get_referenced_by_response : sig
  type t = { referenced_by : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetReferencedByResponse ] Models.t -> t
end
module Get_referenced_by_response_referenced_by_item : sig
  type t = { id : Yojson.Raw.t; resource_name : string Types.presence; target : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetReferencedByResponseReferencedByItem ] Models.t -> t
end
module Get_resource_by_token_response : sig
  type t = { source_resource : Yojson.Raw.t; expires_at : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetResourceByTokenResponse ] Models.t -> t
end
module Get_resource_response : sig
  type t = { resource : Yojson.Raw.t; annotations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetResourceResponse ] Models.t -> t
end
module Get_tag_schemas_response : sig
  type t = { tag_schemas : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GetTagSchemasResponse ] Models.t -> t
end
module Health_response : sig
  type t = { status : string; message : string; version : string; timestamp : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `HealthResponse ] Models.t -> t
end
module Inference_limits : sig
  type t = { context_tokens : Yojson.Raw.t; max_output_tokens : Yojson.Raw.t; accepts_temperature : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `InferenceLimits ] Models.t -> t
end
module Inference_limits_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `InferenceLimitsResult ] Models.t -> t
end
module Engine_limits : sig
  type t = { engine : Yojson.Raw.t; limits : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `EngineLimits ] Models.t -> t
end
module Graph_annotation_node : sig
  type t = { id : Yojson.Raw.t; type_ : string; label : string; entity_types : Yojson.Raw.t Types.presence; annotation : Yojson.Raw.t; metadata : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GraphAnnotationNode ] Models.t -> t
end
module Graph_resource_node : sig
  type t = { id : Yojson.Raw.t; type_ : string; label : string; entity_types : Yojson.Raw.t Types.presence; metadata : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GraphResourceNode ] Models.t -> t
end
module Job_cancel_request : sig
  type t = { job_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCancelRequest ] Models.t -> t
end
module Job_cancel_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; annotation_id : Yojson.Raw.t Types.presence; completed_units : Yojson.Raw.t Types.presence; unit_cursors : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCancelCommand ] Models.t -> t
end
module Job_claim_command : sig
  type t = { accepts : Yojson.Raw.t; field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobClaimCommand ] Models.t -> t
end
module Job_completed_payload : sig
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; total_steps : Yojson.Raw.t Types.presence; found_count : Yojson.Raw.t Types.presence; result_resource_id : Yojson.Raw.t Types.presence; annotation_uri : string Types.presence; result : Yojson.Raw.t Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCompletedPayload ] Models.t -> t
end
module Job_created_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCreatedResult ] Models.t -> t
end
module Job_created_result_response : sig
  type t = { job_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCreatedResultResponse ] Models.t -> t
end
module Job_fail_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; error : string; completed_units : Yojson.Raw.t Types.presence; unit_cursors : Yojson.Raw.t Types.presence; failure_class : Yojson.Raw.t Types.presence; will_retry : bool Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobFailCommand ] Models.t -> t
end
module Job_checkpoint_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t; completed_units : Yojson.Raw.t; unit_cursors : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCheckpointCommand ] Models.t -> t
end
module Unit_cursor : sig
  type t = { next : Yojson.Raw.t; size : Yojson.Raw.t; found : Yojson.Raw.t; emitted : Yojson.Raw.t; errors : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `UnitCursor ] Models.t -> t
end
module Job_declined : sig
  type t = { declined : bool; reason : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobDeclined ] Models.t -> t
end
module Job_failed_payload : sig
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; error : string; failure_class : Yojson.Raw.t Types.presence; will_retry : bool Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobFailedPayload ] Models.t -> t
end
module Yield_job_done : sig
  type t = { resource_id : Yojson.Raw.t; resource_name : string; truncated : bool; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldJobDone ] Models.t -> t
end
module Job_progress : sig
  type t = { percentage : Yojson.Raw.t; message : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; current : Yojson.Raw.t Types.presence; processed : Yojson.Raw.t Types.presence; total : Yojson.Raw.t Types.presence; entities_found : Yojson.Raw.t Types.presence; entities_expected : Yojson.Raw.t Types.presence; entities_emitted : Yojson.Raw.t Types.presence; completed_items : Yojson.Raw.t Types.presence; request_params : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgress ] Models.t -> t
end
module Job_progress_analyzing : sig
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressAnalyzing ] Models.t -> t
end
module Job_progress_analyzing_tags : sig
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressAnalyzingTags ] Models.t -> t
end
module Job_progress_complete_created : sig
  type t = { code : string; count : Yojson.Raw.t; motivation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressCompleteCreated ] Models.t -> t
end
module Job_progress_complete_generated : sig
  type t = { code : string; truncated : bool; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressCompleteGenerated ] Models.t -> t
end
module Job_progress_creating_annotations : sig
  type t = { code : string; count : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressCreatingAnnotations ] Models.t -> t
end
module Job_progress_creating_resource : sig
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressCreatingResource ] Models.t -> t
end
module Job_progress_creating_tag_annotations : sig
  type t = { code : string; count : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressCreatingTagAnnotations ] Models.t -> t
end
module Job_progress_detecting_entities : sig
  type t = { code : string; entity_type : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressDetectingEntities ] Models.t -> t
end
module Job_progress_generating_resource : sig
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressGeneratingResource ] Models.t -> t
end
module Job_progress_loading : sig
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobProgressLoading ] Models.t -> t
end
module Mark_job_done : sig
  type t = { found : Yojson.Raw.t; persisted : Yojson.Raw.t; errors : Yojson.Raw.t Types.presence; by_category : Yojson.Raw.t Types.presence; under_reported_pieces : Yojson.Raw.t Types.presence; unchecked_pieces : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkJobDone ] Models.t -> t
end
module Job_report_progress_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; percentage : Yojson.Raw.t; progress : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobReportProgressCommand ] Models.t -> t
end
module Job_start_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; annotation_id : Yojson.Raw.t Types.presence; attempt : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobStartCommand ] Models.t -> t
end
module Job_assign_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; resource_id : Yojson.Raw.t; holder : Yojson.Raw.t; requester : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobAssignCommand ] Models.t -> t
end
module Job_started_payload : sig
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; annotation_id : Yojson.Raw.t Types.presence; total_steps : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobStartedPayload ] Models.t -> t
end
module Job_assigned_payload : sig
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; resource_id : Yojson.Raw.t; holder : Yojson.Raw.t; requester : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobAssignedPayload ] Models.t -> t
end
module Principal_profile_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; name : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `PrincipalProfileCommand ] Models.t -> t
end
module Principal_profiled_payload : sig
  type t = { name : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `PrincipalProfiledPayload ] Models.t -> t
end
module Job_status_request : sig
  type t = { job_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobStatusRequest ] Models.t -> t
end
module Job_status_response : sig
  type t = { job_id : Yojson.Raw.t; type_ : Yojson.Raw.t; status : string; user_id : Yojson.Raw.t; created : string; started_at : string Types.presence; completed_at : string Types.presence; error : string Types.presence; failure_class : Yojson.Raw.t Types.presence; progress : Yojson.Raw.t Types.presence; result : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobStatusResponse ] Models.t -> t
end
module Job_status_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobStatusResult ] Models.t -> t
end
module Kb_description : sig
  type t = { name : string; domain : string; git_branch : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `KbDescription ] Models.t -> t
end
module Http_endpoint : sig
  type t = { kind : string; host : string; port : Yojson.Raw.t; protocol : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `HttpEndpoint ] Models.t -> t
end
module Kb_read : sig
  type t = { at : string; git_branch : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `KbRead ] Models.t -> t
end
module Kb_target : sig
  type t = { id : string; label : string; endpoint : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `KbTarget ] Models.t -> t
end
module Knowledge_base : sig
  type t = { id : string; label : Yojson.Raw.t; endpoint : Yojson.Raw.t; did : string; last_read : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `KnowledgeBase ] Models.t -> t
end
module Local_endpoint : sig
  type t = { kind : string; kb_id : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `LocalEndpoint ] Models.t -> t
end
module New_knowledge_base : sig
  type t = { label : string; endpoint : Yojson.Raw.t; did : string; last_read : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `NewKnowledgeBase ] Models.t -> t
end
module Knowledge_graph : sig
  type t = { nodes : Yojson.Raw.t; edges : Yojson.Raw.t; truncated : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `KnowledgeGraph ] Models.t -> t
end
module List_resources_response : sig
  type t = { resources : Yojson.Raw.t; total : Yojson.Raw.t; offset : Yojson.Raw.t; limit : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ListResourcesResponse ] Models.t -> t
end
module Mark_archive_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; storage_uri : string Types.presence; keep_file : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkArchiveCommand ] Models.t -> t
end
module Mark_create_ok : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkCreateOk ] Models.t -> t
end
module Mark_create_ok_response : sig
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkCreateOkResponse ] Models.t -> t
end
module Mark_commit_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; annotations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkCommitCommand ] Models.t -> t
end
module Mark_commit_ok : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkCommitOk ] Models.t -> t
end
module Mark_create_request : sig
  type t = { resource_id : Yojson.Raw.t; request : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkCreateRequest ] Models.t -> t
end
module Mark_delete_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkDeleteCommand ] Models.t -> t
end
module Mark_delete_ok : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkDeleteOk ] Models.t -> t
end
module Mark_requested_event : sig
  type t = { source : Yojson.Raw.t; selector : Yojson.Raw.t; motivation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkRequestedEvent ] Models.t -> t
end
module Mark_submit_event : sig
  type t = { source : Yojson.Raw.t; motivation : Yojson.Raw.t; selector : Yojson.Raw.t; body : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkSubmitEvent ] Models.t -> t
end
module Mark_unarchive_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; storage_uri : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkUnarchiveCommand ] Models.t -> t
end
module Mark_update_body_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkUpdateBodyCommand ] Models.t -> t
end
module Mark_update_entity_types_command : sig
  type t = { resource_id : Yojson.Raw.t; field_user_id : Yojson.Raw.t Types.presence; current_entity_types : Yojson.Raw.t; updated_entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkUpdateEntityTypesCommand ] Models.t -> t
end
module Match_search_failed : sig
  type t = { reference_id : Yojson.Raw.t; error : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MatchSearchFailed ] Models.t -> t
end
module Match_search_request : sig
  type t = { resource_id : Yojson.Raw.t; reference_id : Yojson.Raw.t; context : Yojson.Raw.t; limit : Yojson.Raw.t Types.presence; use_semantic_scoring : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MatchSearchRequest ] Models.t -> t
end
module Match_search_result : sig
  type t = { reference_id : Yojson.Raw.t; response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MatchSearchResult ] Models.t -> t
end
module Match_resources_request : sig
  type t = { search : string; archived : bool Types.presence; entity_type : string Types.presence; offset : Yojson.Raw.t Types.presence; limit : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MatchResourcesRequest ] Models.t -> t
end
module Match_resources_response : sig
  type t = { resources : Yojson.Raw.t; total : Yojson.Raw.t; offset : Yojson.Raw.t; limit : Yojson.Raw.t; match_kind : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MatchResourcesResponse ] Models.t -> t
end
module Match_resources_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MatchResourcesResult ] Models.t -> t
end
module Media_token_request : sig
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MediaTokenRequest ] Models.t -> t
end
module Media_token_response : sig
  type t = { token : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MediaTokenResponse ] Models.t -> t
end
module Protected_resource_metadata : sig
  type t = { resource : string; authorization_servers : Yojson.Raw.t; bearer_methods_supported : Yojson.Raw.t; resource_name : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ProtectedResourceMetadata ] Models.t -> t
end
module Representation : sig
  type t = { field_id : string Types.presence; field_type : Yojson.Raw.t Types.presence; media_type : string; storage_uri : string Types.presence; filename : string Types.presence; byte_size : Yojson.Raw.t Types.presence; checksum : string Types.presence; encoding : string Types.presence; language : string Types.presence; width : Yojson.Raw.t Types.presence; height : Yojson.Raw.t Types.presence; duration : Yojson.Raw.t Types.presence; created : string Types.presence; modified : string Types.presence; conforms_to : Yojson.Raw.t Types.presence; tags : Yojson.Raw.t Types.presence; rel : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `Representation ] Models.t -> t
end
module Representation_added_payload : sig
  type t = { representation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `RepresentationAddedPayload ] Models.t -> t
end
module Representation_removed_payload : sig
  type t = { checksum : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `RepresentationRemovedPayload ] Models.t -> t
end
module Resource_archived_payload : sig
  type t = { reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceArchivedPayload ] Models.t -> t
end
module Resource_cloned_payload : sig
  type t = { name : string; format : Yojson.Raw.t; content_checksum : string; content_byte_size : Yojson.Raw.t Types.presence; storage_uri : string Types.presence; parent_resource_id : Yojson.Raw.t; entity_types : Yojson.Raw.t Types.presence; language : string Types.presence; creator : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceClonedPayload ] Models.t -> t
end
module Resource_created_payload : sig
  type t = { name : string; format : Yojson.Raw.t; content_checksum : string; content_byte_size : Yojson.Raw.t Types.presence; entity_types : Yojson.Raw.t Types.presence; storage_uri : string Types.presence; language : string Types.presence; is_draft : bool Types.presence; job_id : Yojson.Raw.t Types.presence; generated_from : Yojson.Raw.t Types.presence; generation_prompt : string Types.presence; generator : Yojson.Raw.t Types.presence; creator : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceCreatedPayload ] Models.t -> t
end
module Resource_descriptor : sig
  type t = { field_context : Yojson.Raw.t; field_id : Yojson.Raw.t; field_type : Yojson.Raw.t Types.presence; name : string; description : string Types.presence; identifier : Yojson.Raw.t Types.presence; about : Yojson.Raw.t Types.presence; same_as : Yojson.Raw.t Types.presence; is_part_of : Yojson.Raw.t Types.presence; has_part : Yojson.Raw.t Types.presence; license : string Types.presence; version : string Types.presence; date_created : string Types.presence; date_modified : string Types.presence; was_derived_from : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; generator : Yojson.Raw.t Types.presence; conforms_to : Yojson.Raw.t Types.presence; available_formats : Yojson.Raw.t Types.presence; representations : Yojson.Raw.t; archived : bool Types.presence; entity_types : Yojson.Raw.t Types.presence; is_draft : bool Types.presence; source_annotation_id : Yojson.Raw.t Types.presence; source_resource_id : Yojson.Raw.t Types.presence; originated_from : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceDescriptor ] Models.t -> t
end
module Resource_moved_payload : sig
  type t = { from_uri : string; to_uri : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceMovedPayload ] Models.t -> t
end
module Resource_updated_payload : sig
  type t = { content_checksum : string; content_byte_size : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceUpdatedPayload ] Models.t -> t
end
module Scored_resource : sig
  type t = { field_context : Yojson.Raw.t; field_id : Yojson.Raw.t; field_type : Yojson.Raw.t Types.presence; name : string; description : string Types.presence; identifier : Yojson.Raw.t Types.presence; about : Yojson.Raw.t Types.presence; same_as : Yojson.Raw.t Types.presence; is_part_of : Yojson.Raw.t Types.presence; has_part : Yojson.Raw.t Types.presence; license : string Types.presence; version : string Types.presence; date_created : string Types.presence; date_modified : string Types.presence; was_derived_from : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; generator : Yojson.Raw.t Types.presence; conforms_to : Yojson.Raw.t Types.presence; available_formats : Yojson.Raw.t Types.presence; representations : Yojson.Raw.t; archived : bool Types.presence; entity_types : Yojson.Raw.t Types.presence; is_draft : bool Types.presence; source_annotation_id : Yojson.Raw.t Types.presence; source_resource_id : Yojson.Raw.t Types.presence; originated_from : string Types.presence; score : Yojson.Raw.t Types.presence; match_reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ScoredResource ] Models.t -> t
end
module Semantic_match : sig
  type t = { text : string; resource_id : Yojson.Raw.t; resource_name : string; annotation_id : Yojson.Raw.t Types.presence; score : Yojson.Raw.t; entity_types : Yojson.Raw.t Types.presence; machine_read : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SemanticMatch ] Models.t -> t
end
module Session_joined_event : sig
  type t = { participant : Yojson.Raw.t; connection_id : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SessionJoinedEvent ] Models.t -> t
end
module Session_left_event : sig
  type t = { participant : Yojson.Raw.t; connection_id : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SessionLeftEvent ] Models.t -> t
end
module Settings_hover_delay_changed_event : sig
  type t = { hover_delay_ms : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SettingsHoverDelayChangedEvent ] Models.t -> t
end
module Settings_locale_changed_event : sig
  type t = { locale : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SettingsLocaleChangedEvent ] Models.t -> t
end
module Settings_theme_changed_event : sig
  type t = { theme : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SettingsThemeChangedEvent ] Models.t -> t
end
module Specific_resource : sig
  type t = { type_ : string; source : Yojson.Raw.t; purpose : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SpecificResource ] Models.t -> t
end
module Status_response : sig
  type t = { status : string; version : string; features : Yojson.Raw.t; message : string; authenticated_as : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `StatusResponse ] Models.t -> t
end
module Stored_event_response : sig
  type t = { id : string; type_ : string; timestamp : string; user_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; version : Yojson.Raw.t; payload : Yojson.Raw.t; metadata : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `StoredEventResponse ] Models.t -> t
end
module Svg_selector : sig
  type t = { type_ : string; value : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SvgSelector ] Models.t -> t
end
module Tag_category : sig
  type t = { name : string; description : string; examples : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TagCategory ] Models.t -> t
end
module Tag_schema : sig
  type t = { id : string; name : string; description : string; domain : string; tags : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TagSchema ] Models.t -> t
end
module Tag_schema_added_payload : sig
  type t = { schema : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TagSchemaAddedPayload ] Models.t -> t
end
module Text_position_selector : sig
  type t = { type_ : string; start : Yojson.Raw.t; end_ : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TextPositionSelector ] Models.t -> t
end
module Text_quote_selector : sig
  type t = { type_ : string; exact : string; prefix : string Types.presence; suffix : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TextQuoteSelector ] Models.t -> t
end
module Textual_body : sig
  type t = { type_ : string; value : string; purpose : Yojson.Raw.t Types.presence; format : string Types.presence; language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TextualBody ] Models.t -> t
end
module Update_annotation_body_request : sig
  type t = { resource_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `UpdateAnnotationBodyRequest ] Models.t -> t
end
module User_response : sig
  type t = { did : Yojson.Raw.t; email : Yojson.Raw.t; name : Yojson.Raw.t; image : Yojson.Raw.t; domain : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `UserResponse ] Models.t -> t
end
module Smelt_rebuild_anchors_command : sig
  type t = { resource_id : Yojson.Raw.t Types.presence; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SmeltRebuildAnchorsCommand ] Models.t -> t
end
module Weave_rebuild_command : sig
  type t = { resource_id : Yojson.Raw.t Types.presence; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WeaveRebuildCommand ] Models.t -> t
end
module Yield_clone_create_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; token : string; name : string; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; format : Yojson.Raw.t; archive_original : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldCloneCreateCommand ] Models.t -> t
end
module Yield_clone_created : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldCloneCreated ] Models.t -> t
end
module Yield_clone_resource_request : sig
  type t = { token : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldCloneResourceRequest ] Models.t -> t
end
module Yield_clone_token_request : sig
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldCloneTokenRequest ] Models.t -> t
end
module Yield_create_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t Types.presence; name : string; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; format : Yojson.Raw.t; language : string Types.presence; entity_types : Yojson.Raw.t Types.presence; is_draft : bool Types.presence; generated_from : Yojson.Raw.t Types.presence; generation_prompt : string Types.presence; generator : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldCreateCommand ] Models.t -> t
end
module Yield_clone_persist_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; name : string; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; format : Yojson.Raw.t; language : string Types.presence; entity_types : Yojson.Raw.t Types.presence; parent_resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldClonePersistCommand ] Models.t -> t
end
module Yield_create_ok : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldCreateOk ] Models.t -> t
end
module Yield_clone_persist_ok : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldClonePersistOk ] Models.t -> t
end
module Yield_update_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldUpdateCommand ] Models.t -> t
end
module Yield_update_ok : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldUpdateOk ] Models.t -> t
end
module Bus_event_message : sig
  type t = { event : string; id : Yojson.Raw.t; data : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BusEventMessage ] Models.t -> t
end
module Bus_frame : sig
  type t = { channel : string; correlation_id : string Types.presence; payload : Yojson.Raw.t; scope : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BusFrame ] Models.t -> t
end
module Bus_ping_message : sig
  type t = { event : string; data : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BusPingMessage ] Models.t -> t
end
module Bus_resume_gap : sig
  type t = { scope : Yojson.Raw.t; last_seen_id : string; reason : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BusResumeGap ] Models.t -> t
end
module Gateway_config : sig
  type t = { kb : Yojson.Raw.t; port : Yojson.Raw.t; public_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; signal : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; capacity : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatewayConfig ] Models.t -> t
end
module Kb_identity : sig
  type t = { name : string; domain : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `KbIdentity ] Models.t -> t
end
module Resource_upload : sig
  type t = { name : string; file : string; format : string; storage_uri : string; language : string Types.presence; entity_types : string Types.presence; source_annotation_id : Yojson.Raw.t Types.presence; source_resource_id : Yojson.Raw.t Types.presence; generation_prompt : string Types.presence; generator : string Types.presence; job_id : Yojson.Raw.t Types.presence; is_draft : string Types.presence; clone_token : string Types.presence; archive_original : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceUpload ] Models.t -> t
end
module Archivist_events_response : sig
  type t = { events : Yojson.Raw.t; last_sequence : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ArchivistEventsResponse ] Models.t -> t
end
module Archivist_stream : sig
  type t = { resource_id : Yojson.Raw.t; last_sequence : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ArchivistStream ] Models.t -> t
end
module Archivist_streams_response : sig
  type t = { streams : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ArchivistStreamsResponse ] Models.t -> t
end
module Archivist_health : sig
  type t = { status : string; actors : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ArchivistHealth ] Models.t -> t
end
module Representation_not_found : sig
  type t = { error : string; code : Yojson.Raw.t; hint : string Types.presence; details : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `RepresentationNotFound ] Models.t -> t
end
module Limit_refusal : sig
  type t = { error : string; code : Yojson.Raw.t; hint : string Types.presence; details : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `LimitRefusal ] Models.t -> t
end
module Job_metadata : sig
  type t = { id : Yojson.Raw.t; type_ : Yojson.Raw.t; user_id : Yojson.Raw.t; created : string; retry_count : Yojson.Raw.t; max_retries : Yojson.Raw.t; completed_units : Yojson.Raw.t Types.presence; unit_cursors : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobMetadata ] Models.t -> t
end
module Job_params : sig
  type t = { resource_id : Yojson.Raw.t; schema : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobParams ] Models.t -> t
end
module Highlighting_job_params : sig
  type t = { motivation : string; instructions : string Types.presence; density : Yojson.Raw.t Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `HighlightingJobParams ] Models.t -> t
end
module Commenting_job_params : sig
  type t = { motivation : string; instructions : string Types.presence; tone : string Types.presence; density : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `CommentingJobParams ] Models.t -> t
end
module Assessing_job_params : sig
  type t = { motivation : string; instructions : string Types.presence; tone : string Types.presence; density : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AssessingJobParams ] Models.t -> t
end
module Linking_job_params : sig
  type t = { motivation : string; entity_types : Yojson.Raw.t; include_descriptive_references : bool Types.presence; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `LinkingJobParams ] Models.t -> t
end
module Tagging_job_params : sig
  type t = { motivation : string; schema_id : string; categories : Yojson.Raw.t; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TaggingJobParams ] Models.t -> t
end
module Generation_job_request : sig
  type t = { title : string; storage_uri : string; prompt : string Types.presence; entity_types : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; temperature : Yojson.Raw.t Types.presence; max_tokens : Yojson.Raw.t Types.presence; output_media_type : Yojson.Raw.t Types.presence; task : string Types.presence; structure : string Types.presence; cite : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GenerationJobRequest ] Models.t -> t
end
module Mark_job_create_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_type : string; resource_id : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkJobCreateCommand ] Models.t -> t
end
module Yield_job_create_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_type : string; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldJobCreateCommand ] Models.t -> t
end
module Mark_job_queued_event : sig
  type t = { job_id : Yojson.Raw.t; job_type : string; resource_id : Yojson.Raw.t; user_id : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkJobQueuedEvent ] Models.t -> t
end
module Yield_job_queued_event : sig
  type t = { job_id : Yojson.Raw.t; job_type : string; resource_id : Yojson.Raw.t; user_id : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldJobQueuedEvent ] Models.t -> t
end
module Mark_job_complete_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : string; attempt : Yojson.Raw.t Types.presence; result : Yojson.Raw.t Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkJobCompleteCommand ] Models.t -> t
end
module Yield_job_complete_command : sig
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : string; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; result : Yojson.Raw.t Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldJobCompleteCommand ] Models.t -> t
end
module Mark_job_filter : sig
  type t = { job_type : string; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkJobFilter ] Models.t -> t
end
module Yield_job_filter : sig
  type t = { job_type : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `YieldJobFilter ] Models.t -> t
end
module Job_pending : sig
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobPending ] Models.t -> t
end
module Job_running : sig
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string; progress : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobRunning ] Models.t -> t
end
module Job_complete : sig
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string; completed_at : string; result : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobComplete ] Models.t -> t
end
module Job_failed : sig
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string Types.presence; completed_at : string; error : string; failure_class : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobFailed ] Models.t -> t
end
module Job_cancelled : sig
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string Types.presence; completed_at : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCancelled ] Models.t -> t
end
module Job_record : sig
  type t = { job : Yojson.Raw.t; last_progress_at : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobRecord ] Models.t -> t
end
module Job_claimed_result : sig
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobClaimedResult ] Models.t -> t
end
module Dispatcher_config : sig
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; queue : Yojson.Raw.t; port : Yojson.Raw.t; timing : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `DispatcherConfig ] Models.t -> t
end
module Worker_config : sig
  type t = { knowledge_bases : Yojson.Raw.t; model_catalogue : string; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WorkerConfig ] Models.t -> t
end
module Worker_engine_config : sig
  type t = { engine : Yojson.Raw.t; jobs : Yojson.Raw.t; base_url : string; api_key_env : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WorkerEngineConfig ] Models.t -> t
end
module Worker_knowledge_base_config : sig
  type t = { domain : string; gateway_url : string; identity : Yojson.Raw.t; engines : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WorkerKnowledgeBaseConfig ] Models.t -> t
end
module Worker_health : sig
  type t = { status : string; knowledge_bases : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WorkerHealth ] Models.t -> t
end
module Worker_knowledge_base_health : sig
  type t = { domain : string; state : string; did : string Types.presence; engines : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WorkerKnowledgeBaseHealth ] Models.t -> t
end
module Worker_engine_health : sig
  type t = { engine : Yojson.Raw.t; jobs : Yojson.Raw.t; last_queued_event_at : Yojson.Raw.t; last_claim_at : Yojson.Raw.t; last_finished_at : Yojson.Raw.t; last_activity_at : Yojson.Raw.t; active_job : Yojson.Raw.t; jobs_completed : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WorkerEngineHealth ] Models.t -> t
end
module Weaver_config : sig
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; graph : Yojson.Raw.t; cursors_path : Yojson.Raw.t; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WeaverConfig ] Models.t -> t
end
module Neo4j_graph_config : sig
  type t = { type_ : string; uri : string; username : string; password_env : string; database : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `Neo4jGraphConfig ] Models.t -> t
end
module Janus_graph_config : sig
  type t = { type_ : string; host : string; port : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JanusGraphConfig ] Models.t -> t
end
module Neptune_graph_config : sig
  type t = { type_ : string; endpoint : string; port : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `NeptuneGraphConfig ] Models.t -> t
end
module Memory_graph_config : sig
  type t = { type_ : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MemoryGraphConfig ] Models.t -> t
end
module Smelter_config : sig
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; embedding : Yojson.Raw.t; vectors : Yojson.Raw.t; chunking : Yojson.Raw.t; pdfs_at_once : Yojson.Raw.t; cursors_path : Yojson.Raw.t; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SmelterConfig ] Models.t -> t
end
module Librarian_config : sig
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; graph : Yojson.Raw.t; vectors : Yojson.Raw.t; embedding : Yojson.Raw.t; matcher : Yojson.Raw.t; gatherer : Yojson.Raw.t; model_catalogue : string; gather : Yojson.Raw.t; search : Yojson.Raw.t; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `LibrarianConfig ] Models.t -> t
end
module Librarian_engine_config : sig
  type t = { engine : Yojson.Raw.t; base_url : string; api_key_env : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `LibrarianEngineConfig ] Models.t -> t
end
module Ollama_embedding_config : sig
  type t = { type_ : string; model : string; base_url : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `OllamaEmbeddingConfig ] Models.t -> t
end
module Voyage_embedding_config : sig
  type t = { type_ : string; model : string; endpoint : string; api_key_env : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `VoyageEmbeddingConfig ] Models.t -> t
end
module Qdrant_vectors_config : sig
  type t = { type_ : string; host : string; port : Yojson.Raw.t; token_env : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `QdrantVectorsConfig ] Models.t -> t
end
module Memory_vectors_config : sig
  type t = { type_ : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MemoryVectorsConfig ] Models.t -> t
end
module Dispatcher_health : sig
  type t = { status : string; queue : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `DispatcherHealth ] Models.t -> t
end
module Archivist_config : sig
  type t = { gateway_url : string; identity : Yojson.Raw.t; root : string; state_home : string; anchored_text_dir : string; engines : Yojson.Raw.t; port : Yojson.Raw.t; skip_rebuild : bool; staging : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ArchivistConfig ] Models.t -> t
end
module Resource_annotations : sig
  type t = { resource_id : Yojson.Raw.t; annotations : Yojson.Raw.t; version : Yojson.Raw.t; updated_at : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceAnnotations ] Models.t -> t
end
module Resource_view : sig
  type t = { resource : Yojson.Raw.t; annotations : Yojson.Raw.t; last_sequence : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceView ] Models.t -> t
end
module Entity_types_projection : sig
  type t = { entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `EntityTypesProjection ] Models.t -> t
end
module Tag_schemas_projection : sig
  type t = { tag_schemas : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `TagSchemasProjection ] Models.t -> t
end
module Profiles_projection : sig
  type t = { profiles : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ProfilesProjection ] Models.t -> t
end
module Profile : sig
  type t = { name : string; since : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `Profile ] Models.t -> t
end
module Storage_uri_entry : sig
  type t = { uri : string; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `StorageUriEntry ] Models.t -> t
end
module Anchored_text_extracted_entry : sig
  type t = { v : Yojson.Raw.t; stamp : string; text : string; lines : Yojson.Raw.t; method_ : string; pdf_class : string Types.presence; ocr_confidence : Yojson.Raw.t Types.presence; unread_pages : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnchoredTextExtractedEntry ] Models.t -> t
end
module Anchored_text_declined_entry : sig
  type t = { v : Yojson.Raw.t; stamp : string; declined : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnchoredTextDeclinedEntry ] Models.t -> t
end
module Anchored_text_entries : sig
  type t = { checksums : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnchoredTextEntries ] Models.t -> t
end
module Anchored_text_stamp : sig
  type t = { stamp : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnchoredTextStamp ] Models.t -> t
end
module Anchored_text_write : sig
  type t = { content_checksum : string; entry : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `AnchoredTextWrite ] Models.t -> t
end
module Archivist_engines : sig
  type t = { jobs : Yojson.Raw.t; actors : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ArchivistEngines ] Models.t -> t
end
module Engine : sig
  type t = { provider : string; model : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `Engine ] Models.t -> t
end
module Gather_failed : sig
  type t = { code : string Types.presence; message : string; details : string Types.presence; annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherFailed ] Models.t -> t
end
module Gather_resource_failed : sig
  type t = { code : string Types.presence; message : string; details : string Types.presence; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `GatherResourceFailed ] Models.t -> t
end
module Browse_directory_failed : sig
  type t = { code : string Types.presence; message : string; details : string Types.presence; path : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `BrowseDirectoryFailed ] Models.t -> t
end
module Mark_delegate_timeout_event : sig
  type t = { resource_id : Yojson.Raw.t; motivation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `MarkDelegateTimeoutEvent ] Models.t -> t
end
module Resource_error_event : sig
  type t = { resource_id : Yojson.Raw.t; message : string; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `ResourceErrorEvent ] Models.t -> t
end
module Job_cancel_result : sig
  type t = { cancelled : bool; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `JobCancelResult ] Models.t -> t
end
module Weave_applied : sig
  type t = { resource_id : Yojson.Raw.t; sequence_number : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `WeaveApplied ] Models.t -> t
end
module Smelt_settled : sig
  type t = { resource_id : Yojson.Raw.t; content_checksum : string; outcome : string; reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  val of_model : [ `SmeltSettled ] Models.t -> t
end
module Agent : sig
  type t = Person of Agent_person.t | Organization of Agent_organization.t | Software of Agent_software.t
  val of_model : [ `Agent ] Models.t -> t option
end
module Annotation_body : sig
  type t = TextualBody of Textual_body.t | SpecificResource of Specific_resource.t
  val of_model : [ `AnnotationBody ] Models.t -> t option
end
module Anchored_text_answer : sig
  type t = Extracted of Extracted_text.t | Declined of Extraction_declined.t | NotYet of Anchored_text_absent.t | NoMap of Anchored_text_absent.t | Unknown of Anchored_text_absent.t
  val of_model : [ `AnchoredTextAnswer ] Models.t -> t option
end
module Directory_entry : sig
  type t = File of File_entry.t | Dir of Dir_entry.t
  val of_model : [ `DirectoryEntry ] Models.t -> t option
end
module Extraction_outcome : sig
  type t = Extracted of Extracted_text.t | Declined of Extraction_declined.t
  val of_model : [ `ExtractionOutcome ] Models.t -> t option
end
module Job_complete_command : sig
  type t = Mark of Mark_job_complete_command.t | Yield of Yield_job_complete_command.t
  val of_model : [ `JobCompleteCommand ] Models.t -> t option
end
module Job_create_command : sig
  type t = Mark of Mark_job_create_command.t | Yield of Yield_job_create_command.t
  val of_model : [ `JobCreateCommand ] Models.t -> t option
end
module Job_progress_message : sig
  type t = Loading of Job_progress_loading.t | Analyzing of Job_progress_analyzing.t | AnalyzingTags of Job_progress_analyzing_tags.t | GeneratingResource of Job_progress_generating_resource.t | CreatingResource of Job_progress_creating_resource.t | CompleteGenerated of Job_progress_complete_generated.t | DetectingEntities of Job_progress_detecting_entities.t | CreatingAnnotations of Job_progress_creating_annotations.t | CreatingTagAnnotations of Job_progress_creating_tag_annotations.t | CompleteCreated of Job_progress_complete_created.t
  val of_model : [ `JobProgressMessage ] Models.t -> t option
end
module Job_queued_event : sig
  type t = Mark of Mark_job_queued_event.t | Yield of Yield_job_queued_event.t
  val of_model : [ `JobQueuedEvent ] Models.t -> t option
end
module Kb_endpoint : sig
  type t = Http of Http_endpoint.t | Local of Local_endpoint.t
  val of_model : [ `KbEndpoint ] Models.t -> t option
end
module Selector : sig
  type t = TextPositionSelector of Text_position_selector.t | TextQuoteSelector of Text_quote_selector.t | SvgSelector of Svg_selector.t | FragmentSelector of Fragment_selector.t
  val of_model : [ `Selector ] Models.t -> t option
end
module Mark_job_params : sig
  type t = Highlighting of Highlighting_job_params.t | Commenting of Commenting_job_params.t | Assessing of Assessing_job_params.t | Linking of Linking_job_params.t | Tagging of Tagging_job_params.t
  val of_model : [ `MarkJobParams ] Models.t -> t option
end
module Job_filter : sig
  type t = Mark of Mark_job_filter.t | Yield of Yield_job_filter.t
  val of_model : [ `JobFilter ] Models.t -> t option
end
module Job : sig
  type t = Pending of Job_pending.t | Running of Job_running.t | Complete of Job_complete.t | Failed of Job_failed.t | Cancelled of Job_cancelled.t
  val of_model : [ `Job ] Models.t -> t option
end
module Graph_config : sig
  type t = Neo4j of Neo4j_graph_config.t | Janusgraph of Janus_graph_config.t | Neptune of Neptune_graph_config.t | Memory of Memory_graph_config.t
  val of_model : [ `GraphConfig ] Models.t -> t option
end
module Embedding_config : sig
  type t = Ollama of Ollama_embedding_config.t | Voyage of Voyage_embedding_config.t
  val of_model : [ `EmbeddingConfig ] Models.t -> t option
end
module Vectors_config : sig
  type t = Qdrant of Qdrant_vectors_config.t | Memory of Memory_vectors_config.t
  val of_model : [ `VectorsConfig ] Models.t -> t option
end
