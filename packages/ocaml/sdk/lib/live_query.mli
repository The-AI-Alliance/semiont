(** Domain-affine observed queries with one in-flight read per key. *)

type ('key, 'value) t
type 'value state = Pending | Ready of 'value | Failed of string

val make :
  ?window_ms:int ->
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  load:('key -> ('value, string) result) ->
  ?restore:('key -> 'value option) ->
  ?save:('key -> 'value option -> unit) ->
  hold:('key -> unit -> unit) ->
  unit ->
  ('key, 'value) t

val observe :
  ('key, 'value) t ->
  'key ->
  on_state:('value state -> unit) ->
  on_close:(unit -> unit) ->
  unit ->
  unit

val fresh : ('key, 'value) t -> 'key -> ('value, string) result
val invalidate : ('key, 'value) t -> 'key -> unit

type key = string * string option * string option

val channels : Bus_registry.packed_channel list
val operations : (string * Bus_registry.packed_operation) list

val refetch :
  (key, Yojson.Safe.t) t -> on:string -> payload:Yojson.Safe.t option -> unit

val close : ('key, 'value) t -> unit
val get : ('key, 'value) t -> 'key -> 'value option
val known : ('key, 'value) t -> 'key -> bool
val keys : ('key, 'value) t -> 'key list
val in_flight : ('key, 'value) t -> bool
val invalidate_all : ('key, 'value) t -> unit
val set : ('key, 'value) t -> 'key -> 'value -> unit
val remove : ('key, 'value) t -> 'key -> string -> unit
