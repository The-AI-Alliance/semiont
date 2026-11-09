type t
(** A one-shot upload. Its progress callback runs while [await] sends it. *)

val make : (unit -> (string, Client_core.error) result) -> t
val await : t -> (string, Client_core.error) result
