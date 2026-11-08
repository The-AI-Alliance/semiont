(** A claimed job and its serialized lifecycle over the typed wire. *)

type held
type claim = Held of held | Empty | Refused of string option

val channels : Bus_registry.packed_channel list
val commit_channels : Bus_registry.packed_channel list
val accepts : filters:Yojson.Safe.t -> announcement:Yojson.Safe.t -> bool

val claim :
  Subscription.t ->
  Http_wire.t ->
  client_id:string ->
  correlation_id:string ->
  ?trace:Wire_stream.trace ->
  ?timeout_ms:int ->
  accepts:Yojson.Safe.t ->
  unit ->
  claim

val view : held -> Yojson.Safe.t
val trace : held -> Wire_stream.trace option
val id : held -> string
val start : held -> unit
val progress : held -> percentage:int -> message:Yojson.Safe.t option -> unit

val checkpoint :
  held -> completed:Yojson.Safe.t -> cursors:Yojson.Safe.t -> unit

val commit :
  held ->
  Subscription.t ->
  correlation_id:(unit -> string) ->
  ?timeout_ms:int ->
  resource:Identifiers.Resource_id.t ->
  annotations:Yojson.Safe.t list ->
  unit ->
  (unit, string) result

val complete : held -> Yojson.Safe.t -> unit
val cancel : held -> completed:Yojson.Safe.t option -> unit

val fail :
  held ->
  error:string ->
  failure_class:Enums.Failure_class.t option ->
  completed:Yojson.Safe.t option ->
  cursors:Yojson.Safe.t option ->
  unit

val default_stall_ms : int
val default_stall_check_ms : int
