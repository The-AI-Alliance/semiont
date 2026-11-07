(** Membership of a field which is both optional and nullable. *)
type 'a presence = Absent | Null | Present of 'a
