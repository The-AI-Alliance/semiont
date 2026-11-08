(** Follow delegated jobs over an existing bus subscription. *)

type t
type report_kind = Created | Progress | Complete | Retrying | Refused
type failure = { code : string; failure_class : Enums.Failure_class.t option }

val channels : Bus_registry.packed_channel list
(** Include these channels in the subscription's global channels. *)

val make :
  ?silence_ms:int ->
  ?poll_ms:int ->
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  subscription:Subscription.t ->
  http:Http_wire.t ->
  client_id:string ->
  correlation_id:(unit -> string) ->
  unit ->
  t

val on_frame : t -> (Wire_stream.frame, Wire_stream.refusal) result -> unit
(** Forward the subscription's event callback here. *)

val start :
  t ->
  verb:string ->
  ?resource:string ->
  ?stall_ms:int ->
  params:Yojson.Safe.t ->
  on_report:(report_kind -> Yojson.Safe.t -> unit) ->
  on_failure:(failure -> unit) ->
  on_close:(unit -> unit) ->
  unit ->
  unit ->
  unit
(** Start following a job. The returned function releases the observer. *)
