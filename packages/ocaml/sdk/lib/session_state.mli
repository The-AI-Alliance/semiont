type t
type end_reason = Expired | Refused

val make :
  ?on_auth_failed:(end_reason -> unit) ->
  id:string ->
  kb:[ `KnowledgeBase ] Models.t ->
  Client.t ->
  t
(** Takes ownership of the client's credentials. The caller still owns the
    client. *)

val id : t -> string
val kb : t -> [ `KnowledgeBase ] Models.t
val client : t -> Client.t
val token : t -> string option State_value.t
val user : t -> [ `UserResponse ] Models.t option State_value.t
val stream_state : t -> Subscription.state State_value.t
val errors : t -> Http_wire.failure option State_value.t
val ready : t -> unit
val expires_at : t -> float option
val refresh : t -> ?refused:string -> unit -> string option
val dispose : t -> unit
