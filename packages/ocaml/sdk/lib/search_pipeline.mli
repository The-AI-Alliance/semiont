type search_state = { results : Yojson.Safe.t list; is_searching : bool }
type lookup = string -> (Yojson.Safe.t list option -> unit) -> unit -> unit
type t

val make :
  ?debounce_ms:int ->
  ?initial_query:string ->
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  search:lookup ->
  unit ->
  t

val query : t -> string State_value.t
val state : t -> search_state State_value.t
val set_query : t -> string -> unit
val dispose : t -> unit
