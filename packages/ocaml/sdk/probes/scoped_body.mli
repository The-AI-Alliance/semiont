type t
(** Candidate IO ownership boundary, not a shipped SDK surface. *)

type reader

exception Closed
exception Already_consumed

val with_body : _ Eio.Flow.source -> (t -> 'a) -> 'a
val consume : t -> (reader -> 'a) -> 'a
val read : reader -> Cstruct.t -> int
