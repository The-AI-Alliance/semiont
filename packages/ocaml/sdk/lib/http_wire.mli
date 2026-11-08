type t

type timing = {
  emit_attempts : int;
  emit_initial_delay_ms : int;
  emit_max_delay_ms : int;
  emit_timeout_ms : int;
  request_timeout_ms : int;
}

type failure = { code : string; status : int option }

exception Failed of failure

val default_timing : timing

val make :
  ?timing:timing ->
  ?telemetry:Telemetry.t ->
  clock:Clock.t ->
  session:Session.t ->
  key:(unit -> string) ->
  on_error:(failure -> unit) ->
  call:
    (sw:Eio.Switch.t ->
    meth:string ->
    path:string ->
    headers:(string * string) list ->
    body:string ->
    progress:(int -> unit) option ->
    int * (string * string) list * Eio.Flow.source_ty Eio.Resource.t) ->
  unit ->
  t

val subscribe :
  t ->
  sw:Eio.Switch.t ->
  Subscription.snapshot ->
  bearer:string ->
  (Eio.Buf_read.t, Subscription.credential_error) result

val emit :
  t ->
  client_id:string ->
  ?scope:Identifiers.Resource_id.t ->
  ?correlation_id:string ->
  ?trace:Wire_stream.trace ->
  'a Bus_registry.channel ->
  string ->
  string

val bus_failure : 'a Bus_registry.decoded -> string
val health : t -> string
val status : t -> string
val current_user : t -> string
val protected_resource_metadata : t -> string
val media_token : t -> Identifiers.Resource_id.t -> string
val graph : t -> Identifiers.Resource_id.t -> string
val annotations : t -> Identifiers.Resource_id.t -> string
val anchored_text : t -> Identifiers.Resource_id.t -> string

val with_content :
  t ->
  ?streaming:bool ->
  Identifiers.Resource_id.t ->
  (content_type:string -> Eio.Flow.source_ty Eio.Resource.t -> 'a) ->
  'a

val put :
  t ->
  fields:(string * string) list ->
  bytes:string ->
  on_progress:(int -> unit) ->
  string
