type 'a t
(** A one-shot operation that starts when awaited. *)

val make : (unit -> 'a) -> 'a t
val await : 'a t -> 'a
