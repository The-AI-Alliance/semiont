type fault = Models.fault = {
  member : string;
  reason : [ `Lacks | `Malformed ];
}

let of_error = function
  | Models.Invalid_json _ -> { member = ""; reason = `Malformed }
  | Invalid_payload fault -> fault

let fault_of descriptor source =
  match Models.decode descriptor source with
  | Ok _ -> None
  | Error error -> Some (of_error error)

let said fault =
  match (fault.member, fault.reason) with
  | member, `Lacks -> "it has no `" ^ member ^ "`"
  | "", `Malformed -> "it is malformed"
  | member, `Malformed -> "its `" ^ member ^ "` is malformed"
