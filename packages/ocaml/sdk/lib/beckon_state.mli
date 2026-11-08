type t

val make : Client.t -> resource:Identifiers.Resource_id.t -> t

val hovered_annotation_id :
  t -> Identifiers.Annotation_id.t option State_value.t

val focus : t -> Identifiers.Annotation_id.t -> unit
val dispose : t -> unit
