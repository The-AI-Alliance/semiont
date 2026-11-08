(** Composition of an existing session, HTTP adapter, bus and delegation. *)

type t

val connect :
  ?subscribe_defaults:bool ->
  ?timing:Subscription.timing ->
  ?http_timing:Http_wire.timing ->
  ?telemetry:Telemetry.t ->
  ?delegation_silence_ms:int ->
  ?delegation_poll_ms:int ->
  ?invalidation_window_ms:int ->
  ?restore:(Live_query.key -> Yojson.Safe.t option) ->
  ?save:(Live_query.key -> Yojson.Safe.t option -> unit) ->
  ?persister:Storage_persister.storage_persister ->
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  session:Session.t ->
  client_id:string ->
  key:(unit -> string) ->
  call:
    (sw:Eio.Switch.t ->
    meth:string ->
    path:string ->
    headers:(string * string) list ->
    body:string ->
    progress:(int -> unit) option ->
    int * (string * string) list * Eio.Flow.source_ty Eio.Resource.t) ->
  global:Bus_registry.packed_channel list ->
  on_event:((Wire_stream.frame, Wire_stream.refusal) result -> unit) ->
  on_error:(Http_wire.failure -> unit) ->
  unit ->
  t
(** Starts the bus on [sw]. The caller owns [session] and its lifetime. *)

val switch : t -> Eio.Switch.t
val client_id : t -> string
val next_key : t -> string
val clock : t -> Clock.t
val session : t -> Session.t
val http : t -> Http_wire.t
val subscription : t -> Subscription.t
val delegation : t -> Delegation.t

val emit :
  t ->
  ?scope:Identifiers.Resource_id.t ->
  ?correlation_id:string ->
  'payload Bus_registry.channel ->
  string ->
  string

val request :
  t ->
  ?timeout_ms:int ->
  ?normalize_refusals:bool ->
  ('request, 'reply, 'failure) Bus_registry.operation ->
  string ->
  (('reply, 'failure) Subscription.reply, Subscription.request_error) result

val on_error : t -> (Http_wire.failure -> unit) -> unit -> unit
val close : t -> unit
val await_closed : t -> unit

type error =
  | Transport of Subscription.request_error
  | Refused of string
  | Http of Http_wire.failure

val ask :
  t ->
  ('request, 'reply, 'failure) Bus_registry.operation ->
  'request Bus_registry.decoded ->
  ('reply Bus_registry.decoded, error) result

val publish :
  t ->
  ?correlation_id:string ->
  'a Bus_registry.channel ->
  'a Bus_registry.decoded ->
  unit

val signal :
  t ->
  ?scope:Identifiers.Resource_id.t ->
  'a Bus_registry.channel ->
  'a Bus_registry.decoded ->
  unit

val drive :
  t ->
  ?scope:Identifiers.Resource_id.t ->
  'a Bus_registry.channel ->
  'a Bus_registry.decoded ->
  (int option, error) result

type query

val query : t -> Live_query.key -> query

val observe :
  query ->
  on_state:(Yojson.Safe.t Live_query.state -> unit) ->
  on_close:(unit -> unit) ->
  unit ->
  unit

val fresh : query -> (Yojson.Safe.t, string) result
val invalidate : query -> unit

type unsubscribe = unit -> unit

val on_channel :
  t ->
  'a Bus_registry.channel ->
  ('a Bus_registry.decoded -> unit) ->
  unsubscribe
(** Registers a listener for decoded frames. The returned function releases it.
*)

val content : (unit -> 'a) -> ('a, error) result

val on_frame :
  t -> ((Wire_stream.frame, Wire_stream.refusal) result -> unit) -> unsubscribe
