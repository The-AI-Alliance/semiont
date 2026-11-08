type t = {
  source : Eio.Flow.source_ty Eio.Resource.t;
  mutable open_ : bool;
  mutable consumed : bool;
}

type reader = { body : t; mutable active : bool }

exception Closed
exception Already_consumed

let with_body source use =
  let body =
    {
      source :> Eio.Flow.source_ty Eio.Resource.t;
      open_ = true;
      consumed = false;
    }
  in
  Fun.protect ~finally:(fun () -> body.open_ <- false) (fun () -> use body)

let consume body use =
  if not body.open_ then raise Closed;
  if body.consumed then raise Already_consumed;
  body.consumed <- true;
  let reader = { body; active = true } in
  Fun.protect ~finally:(fun () -> reader.active <- false) (fun () -> use reader)

let read reader buffer =
  if (not reader.body.open_) || not reader.active then raise Closed;
  Eio.Flow.single_read reader.body.source buffer
