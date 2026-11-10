type fault_action =
  | Deliver
  | Drop_reply
  | Delay of int
  | Duplicate_reply
  | Reject_emit

type delivery_op = Write | Transition

type respond =
  channel:string -> Yojson.Safe.t -> (string * Yojson.Safe.t) option

val fault_actions : Random.State.t -> fault_action
val fault_schedules : Random.State.t -> fault_action list
val delivery_ops : Random.State.t -> max_length:int -> delivery_op list

type request_log_entry = {
  channel : string;
  action : fault_action;
  correlation_id : string option;
  retry_key : string;
  payload : Yojson.Safe.t;
}

type transport

val transport :
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  schedule:fault_action list ->
  respond:respond ->
  transport

val request_log : transport -> request_log_entry list
val queue_reply : transport -> (string * Yojson.Safe.t) option -> unit

val deliver :
  transport ->
  ?id:string ->
  ?correlation_id:string ->
  ?scope:string ->
  string ->
  Yojson.Safe.t ->
  unit

val disconnect : transport -> unit

val call :
  ?content:
    (meth:string ->
    path:string ->
    headers:(string * string) list ->
    body:string ->
    int * (string * string) list * Eio.Flow.source_ty Eio.Resource.t) ->
  transport ->
  sw:Eio.Switch.t ->
  meth:string ->
  path:string ->
  headers:(string * string) list ->
  body:string ->
  progress:(int -> unit) option ->
  int * (string * string) list * Eio.Flow.source_ty Eio.Resource.t

type liveness_scenario = {
  outputs : (unit -> unit) list;
  settlements : (unit -> unit) list;
  requests : unit -> request_log_entry list;
}

type liveness_spec = {
  clock : Clock.t;
  timeout_ms : int;
  retry_budget : int;
  schedules : fault_action list list;
  setup : fault_action list -> (liveness_scenario -> unit) -> unit;
}

val assert_liveness_axioms : liveness_spec -> unit

type delivery_subject = {
  write : string -> unit;
  transition : unit -> unit;
  delivered : unit -> string list;
}

val assert_exactly_once_delivery :
  delivery_op list -> ((delivery_subject -> unit) -> unit) -> unit

type test_session_options = {
  client : Client.t;
  id : string;
  kb : Registry.knowledge_base;
}

type test_session = { session : State_units.Session.t; close : unit -> unit }

val create_test_session : test_session_options -> test_session

type renewal = Session.renewal
type scripted_sessions

val scripted_sessions : unit -> scripted_sessions

val queue_session :
  scripted_sessions -> string -> Registry.session_factory -> unit

val factory : scripted_sessions -> Registry.session_factory
val queue_renewal : scripted_sessions -> renewal -> unit
val renew : scripted_sessions -> holding:string option -> renewal

type shared_storage

val shared_storage : unit -> shared_storage
val storage_context : shared_storage -> Storage.t
