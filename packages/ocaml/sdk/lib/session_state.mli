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

val errors :
  t -> on_value:(Client.said -> unit) -> on_close:(unit -> unit) -> unit -> unit
(** Hear what goes wrong, each said once, in the order met: the session's own
    errors, and what its client says on its errors from the client's first
    request on. The first reader is first given the latest
    errorsKeptForFirstReaderCount (protocol/specs/src/client/timing.json) said
    before it came, in order; a later reader hears what is said from when it
    reads. [dispose] ends them: whoever ends both closes the client first, so
    what its closing flush meets is said before they end. The returned function
    stops hearing. *)

val ready : t -> unit
val expires_at : t -> float option
val refresh : t -> ?refused:string -> unit -> string option
val dispose : t -> unit
