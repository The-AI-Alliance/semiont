(* Generated from protocol identifier kinds and shared required shapes. Do not edit. *)
module Resource_id : sig
  type t
  val of_string : string -> (t, string) result
  val to_string : t -> string
  val compare : t -> t -> int
  val equal : t -> t -> bool
end

module Annotation_id : sig
  type t
  val of_string : string -> (t, string) result
  val to_string : t -> string
  val compare : t -> t -> int
  val equal : t -> t -> bool
end

module Job_id : sig
  type t
  val of_string : string -> (t, string) result
  val to_string : t -> string
  val compare : t -> t -> int
  val equal : t -> t -> bool
end

module User_id : sig
  type t
  val of_string : string -> (t, string) result
  val to_string : t -> string
  val compare : t -> t -> int
  val equal : t -> t -> bool
end
