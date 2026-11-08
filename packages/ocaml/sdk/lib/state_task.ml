open Eio.Std

type t = { mutable cancel : unit -> unit; mutable disposed : bool }

let make () = { cancel = ignore; disposed = false }
let disposed t = t.disposed

let cancel t =
  t.cancel ();
  t.cancel <- ignore

let dispose t =
  t.disposed <- true;
  cancel t

let replace t ~sw work =
  cancel t;
  if not t.disposed then (
    let stopped, stop = Promise.create () in
    t.cancel <-
      (fun () ->
        if not (Promise.is_resolved stopped) then Promise.resolve stop ());
    Fiber.fork_daemon ~sw (fun () ->
        Fiber.first
          (fun () ->
            if not (Promise.is_resolved stopped) then
              work (fun () -> not (Promise.is_resolved stopped)))
          (fun () -> Promise.await stopped);
        `Stop_daemon))

let deadline clock delay_ms =
  Mtime.add_span (Clock.monotonic_now clock) Mtime.Span.(max 0 delay_ms * ms)
  |> Option.value ~default:Mtime.max_stamp
