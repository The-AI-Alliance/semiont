type t
type pending_annotation = { selector : Yojson.Safe.t; motivation : string }

val make :
  ?silence_ms:int -> Client.t -> resource:Identifiers.Resource_id.t -> t

val pending_annotation : t -> pending_annotation option State_value.t
val delegating_motivation : t -> string option State_value.t
val progress : t -> Yojson.Safe.t option State_value.t
val progress_motivation : t -> string option State_value.t
val failure : t -> Delegation.failure option State_value.t
val job_id : t -> string option State_value.t
val request_delegate : t -> [ `MarkJobParams ] Models.t -> unit
val cancel_pending : t -> unit
val dismiss_progress : t -> unit
val dispose : t -> unit
