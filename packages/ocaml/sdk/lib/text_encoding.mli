type refusal =
  | Unsupported_media_type of string
  | Unsupported_charset of string

val decode : content_type:string -> string -> (string, refusal) result
(** Decode resource bytes to UTF-8 using the content type and any leading
    byte-order mark. Refused media types and charset labels name the cause. *)
