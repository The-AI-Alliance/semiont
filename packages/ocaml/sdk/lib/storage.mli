type t
(** Text storage supplied by the application. [update] must run its callback and
    commit the replacement atomically across writers. *)

val make :
  get:(string -> string option) ->
  update:(string -> (string option -> string option) -> unit) ->
  ?subscribe:(string -> (string option -> unit) -> unit -> unit) ->
  unit ->
  t

val get : t -> string -> string option
val set : t -> string -> string -> unit
val delete : t -> string -> unit
val update : t -> string -> (string option -> string option) -> unit
val subscribe : t -> string -> (string option -> unit) -> (unit -> unit) option
