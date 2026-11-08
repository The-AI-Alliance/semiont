(* Generated from Python testing/transport.py and testing/liveness.py. Do not edit. *)

[@@@ocamlformat "disable"]
type fault_action = Deliver | Drop_reply | Delay of int | Duplicate_reply | Reject_emit
type delivery_op = Write | Transition
let fault_actions random =
  match Random.State.int random 5 with
  | 0 -> Deliver
  | 1 -> Drop_reply
  | 2 -> Delay (0 + Random.State.int random 6)
  | 3 -> Duplicate_reply
  | 4 -> Reject_emit
  | _ -> assert false
let fault_schedules random =
  List.init (1 + Random.State.int random 8) (fun _ -> fault_actions random)
let slack = 4
