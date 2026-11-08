(** Caller-owned time and non-cryptographic randomness. Share a value among
    makers on the owning Eio domain. *)

type t

val make :
  monotonic:_ Eio.Time.Mono.t ->
  wall:_ Eio.Time.clock ->
  jitter:Random.State.t ->
  t
(** Retains the supplied clocks and random state. *)

val monotonic_now : t -> Mtime.t
val sleep_until : t -> Mtime.t -> unit

val wall_now : t -> float
(** Wall time in seconds since the Unix epoch. *)

val jitter : t -> float
(** Draws a value from zero inclusive to one exclusive from the supplied state.
*)

val with_jitter : t -> (unit -> float) -> t
(** Use a caller-owned draw function returning values in [[0, 1)]. *)
