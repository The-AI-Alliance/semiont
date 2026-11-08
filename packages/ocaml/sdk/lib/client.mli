(** Composition of an existing session, HTTP adapter, bus and delegation. *)

type t

val connect :
  ?timing:Subscription.timing ->
  ?http_timing:Http_wire.timing ->
  ?telemetry:Telemetry.t ->
  ?delegation_silence_ms:int ->
  ?delegation_poll_ms:int ->
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
  ('request, 'reply, 'failure) Bus_registry.operation ->
  string ->
  (('reply, 'failure) Subscription.reply, Subscription.request_error) result

val close : t -> unit
val await_closed : t -> unit
