include module type of Namespace_methods.Browse

val resource_content :
  Client_core.t ->
  Identifiers.Resource_id.t ->
  (string * string, Client_core.error) result

val resource_representation :
  Client_core.t ->
  Identifiers.Resource_id.t ->
  (string * string, Client_core.error) result

val resource_representation_stream :
  Client_core.t ->
  Identifiers.Resource_id.t ->
  (content_type:string -> Eio.Flow.source_ty Eio.Resource.t -> 'a) ->
  ('a, Client_core.error) result

val resource_graph :
  Client_core.t ->
  Identifiers.Resource_id.t ->
  (string, Client_core.error) result

val resource_anchored_text :
  Client_core.t ->
  Identifiers.Resource_id.t ->
  (string, Client_core.error) result

val resource : Client_core.t -> Identifiers.Resource_id.t -> Client_core.query

val annotations :
  Client_core.t -> Identifiers.Resource_id.t -> Client_core.query

val events : Client_core.t -> Identifiers.Resource_id.t -> Client_core.query

val annotation :
  Client_core.t ->
  Identifiers.Resource_id.t ->
  Identifiers.Annotation_id.t ->
  Client_core.query

val resources :
  Client_core.t ->
  [ `BrowseResourcesRequest ] Bus_registry.component Bus_registry.decoded ->
  Client_core.query

val entity_types : Client_core.t -> Client_core.query
val tag_schemas : Client_core.t -> Client_core.query
val engines : Client_core.t -> Client_core.query
