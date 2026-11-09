type session_ended = { reason : string }
type permission_denied = { detail : string option }
type kb_identity_conflict = { expected_did : string; observed_did : string }
type t

val make : unit -> t
val session_ended : t -> session_ended option State_value.t
val permission_denied : t -> permission_denied option State_value.t
val kb_identity_conflict : t -> kb_identity_conflict option State_value.t
val notify_session_ended : t -> reason:string -> unit
val notify_permission_denied : t -> detail:string option -> unit
val notify_kb_identity_conflict : t -> kb_identity_conflict -> unit
val acknowledge_session_ended : t -> unit
val acknowledge_permission_denied : t -> unit
val acknowledge_kb_identity_conflict : t -> unit
val dispose : t -> unit
