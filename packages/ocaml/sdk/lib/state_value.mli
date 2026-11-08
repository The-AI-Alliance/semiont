type 'a t
(** Read-only state with an immediate current value and an explicit lifetime. *)

type 'a writer

val make : 'a -> 'a t * 'a writer
val get : 'a t -> 'a

val observe :
  'a t -> on_value:('a -> unit) -> on_close:(unit -> unit) -> unit -> unit

val set : ?repeat:bool -> 'a writer -> 'a -> unit
val close : 'a writer -> unit
