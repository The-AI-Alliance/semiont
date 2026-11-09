val primary_representation :
  [ `ResourceDescriptor ] Models.t -> Yojson.Raw.t option

val primary_media_type : [ `ResourceDescriptor ] Models.t -> string option
val entity_types : [ `ResourceDescriptor ] Models.t -> string list

val resource_text :
  Client_core.t ->
  Identifiers.Resource_id.t ->
  ((string, Text_encoding.refusal) result, Client_core.error) result
