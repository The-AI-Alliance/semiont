(** Caller-owned session credentials and proactive renewal. *)

type t
type renewal = Renewed of string | Refused | Unavailable

val token_expiry : string -> float option

val refresh_delay : now:float -> string -> float option
(** Read JWT timing claims for scheduling. Authentication is the gateway's. *)

val start :
  ?keep_on_unavailable:bool ->
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  initial_token:string option ->
  renew:(refused:string option -> renewal) ->
  unit ->
  t
(** Own a proactive timer and a single renewal worker on the caller's switch. *)

val credential : t -> string option
val replace : t -> string option -> unit

val refresh_refused : t -> refused:string -> string option
(** Reuse a replacement already held, or join the shared renewal. Cancelling
    this waiter leaves the renewal running for the session. *)

val close : t -> unit
val await_closed : t -> unit
