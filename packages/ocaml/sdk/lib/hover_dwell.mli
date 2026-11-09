type t

val make : ?delay_ms:int -> Client.t -> t
val enter : t -> Identifiers.Annotation_id.t -> unit
val leave : t -> unit
val dispose : t -> unit
