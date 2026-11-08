type session_ended = { reason : string }
type permission_denied = { detail : string option }
type kb_identity_conflict = { expected_did : string; observed_did : string }

type t = {
  ended : session_ended option State_value.t;
  ended_writer : session_ended option State_value.writer;
  denied : permission_denied option State_value.t;
  denied_writer : permission_denied option State_value.writer;
  conflict : kb_identity_conflict option State_value.t;
  conflict_writer : kb_identity_conflict option State_value.writer;
}

let make () =
  let ended, ended_writer = State_value.make None in
  let denied, denied_writer = State_value.make None in
  let conflict, conflict_writer = State_value.make None in
  { ended; ended_writer; denied; denied_writer; conflict; conflict_writer }

let session_ended t = t.ended
let permission_denied t = t.denied
let kb_identity_conflict t = t.conflict

let notify_session_ended t ~reason =
  State_value.set ~repeat:true t.ended_writer (Some { reason })

let notify_permission_denied t ~detail =
  State_value.set ~repeat:true t.denied_writer (Some { detail })

let notify_kb_identity_conflict t conflict =
  State_value.set ~repeat:true t.conflict_writer (Some conflict)

let acknowledge_session_ended t = State_value.set t.ended_writer None
let acknowledge_permission_denied t = State_value.set t.denied_writer None
let acknowledge_kb_identity_conflict t = State_value.set t.conflict_writer None

let dispose t =
  State_value.close t.ended_writer;
  State_value.close t.denied_writer;
  State_value.close t.conflict_writer
