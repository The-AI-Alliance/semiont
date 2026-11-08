type t

val make :
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  load:(string -> (Yojson.Safe.t, string) result) ->
  ?restore:(string -> Yojson.Safe.t option) ->
  ?save:((string * Yojson.Safe.t option) list -> unit) ->
  unit ->
  t

val observe :
  t ->
  string ->
  on_state:(Yojson.Safe.t Live_query.state -> unit) ->
  on_close:(unit -> unit) ->
  unit ->
  unit

val fetch : t -> string -> (Yojson.Safe.t, string) result
val get : t -> string -> Yojson.Safe.t option
val known : t -> string -> bool
val keys : t -> string list
val invalidate : t -> string -> unit
val invalidate_all : t -> unit
val remove : t -> string -> string -> unit
val set : t -> string -> Yojson.Safe.t -> unit
val persistence_pending : t -> bool
val dispose : t -> unit
