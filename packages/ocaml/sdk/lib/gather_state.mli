type t

val make : Client.t -> resource:Identifiers.Resource_id.t -> t
val context : t -> Yojson.Safe.t option State_value.t
val loading : t -> bool State_value.t
val error : t -> Yojson.Safe.t option State_value.t
val annotation_id : t -> Identifiers.Annotation_id.t option State_value.t
val resource_context : t -> Yojson.Safe.t option State_value.t
val resource_loading : t -> bool State_value.t
val resource_error : t -> Yojson.Safe.t option State_value.t

val gather_annotation :
  t ->
  ?context_window:int ->
  ?include_source_context:bool ->
  ?include_target_context:bool ->
  Identifiers.Annotation_id.t ->
  unit

val gather_resource :
  t ->
  ?depth:int ->
  ?max_resources:int ->
  ?include_content:bool ->
  ?include_summary:bool ->
  ?exclude_entity_types:string list ->
  Identifiers.Resource_id.t ->
  unit

val dispose : t -> unit
