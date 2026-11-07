(* Generated from protocol identifier kinds and shared required shapes. Do not edit. *)

[@@@ocamlformat "disable"]
module Resource_id = struct
  type t = string
  let of_string value =
    if Pattern.matches [([(45, 45); (48, 57); (65, 90); (95, 95); (97, 122)], 1, Some 128)] value then Ok value
    else Error "Invalid ResourceId"
  let to_string value = value
  let compare = String.compare
  let equal = String.equal
end

module Annotation_id = struct
  type t = string
  let of_string value =
    if Pattern.matches [([(45, 45); (48, 57); (65, 90); (95, 95); (97, 122)], 1, Some 128)] value then Ok value
    else Error "Invalid AnnotationId"
  let to_string value = value
  let compare = String.compare
  let equal = String.equal
end

module Job_id = struct
  type t = string
  let of_string value =
    if Pattern.matches [([(45, 45); (48, 57); (65, 90); (95, 95); (97, 122)], 1, Some 128)] value then Ok value
    else Error "Invalid JobId"
  let to_string value = value
  let compare = String.compare
  let equal = String.equal
end

module User_id = struct
  type t = string
  let of_string value =
    if Pattern.matches [([(100, 100)], 1, Some 1); ([(105, 105)], 1, Some 1); ([(100, 100)], 1, Some 1); ([(58, 58)], 1, Some 1); ([(0, 8); (14, 31); (33, 159); (161, 5759); (5761, 8191); (8203, 8231); (8234, 8238); (8240, 8286); (8288, 12287); (12289, 65278); (65280, 1114111)], 1, None)] value then Ok value
    else Error "Invalid UserId"
  let to_string value = value
  let compare = String.compare
  let equal = String.equal
end
