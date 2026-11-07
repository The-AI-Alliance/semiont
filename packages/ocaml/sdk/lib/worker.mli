(** A claimed job and its serialized lifecycle over the typed wire. *)

type held
type claim = Held of held | Empty | Refused of string option

val channels : Bus_registry.packed_channel list
val accepts : filters:Yojson.Safe.t -> announcement:Yojson.Safe.t -> bool

val claim :
  Subscription.t ->
  Http_wire.t ->
  client_id:string ->
  correlation_id:string ->
  ?timeout_ms:int ->
  accepts:Yojson.Safe.t ->
  unit ->
  claim

val view : held -> Yojson.Safe.t
val id : held -> string
val start : held -> unit
val progress : held -> percentage:int -> message:Yojson.Safe.t option -> unit

val checkpoint :
  held -> completed:Yojson.Safe.t -> cursors:Yojson.Safe.t -> unit

val complete : held -> Yojson.Safe.t -> unit
val cancel : held -> completed:Yojson.Safe.t option -> unit

val fail :
  held ->
  error:string ->
  failure_class:Enums.Failure_class.t option ->
  completed:Yojson.Safe.t option ->
  cursors:Yojson.Safe.t option ->
  unit
