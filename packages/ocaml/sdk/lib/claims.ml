open Eio.Std
module B = Bus_registry
module S = Subscription

type t = {
  client : Client_core.t;
  accepts : Yojson.Safe.t;
  timeout_ms : int option;
  trace : unit -> Wire_stream.trace option;
  on_refused : string option -> unit;
  on_cancel : Worker.held -> unit;
  mutable held : Worker.held option;
  mutable waiting : bool;
  mutable release : Client_core.unsubscribe option;
  mutable wake : unit Promise.t * unit Promise.u;
  stopped : unit Promise.t;
  stop_now : unit Promise.u;
}

let make client ?timeout_ms ?(trace = fun () -> None) ?(on_refused = ignore)
    ?(on_cancel = ignore) filters =
  let accepts =
    `List
      (List.map
         (fun filter -> Yojson.Safe.from_string (Models.encode filter))
         filters)
  in
  let stopped, stop_now = Promise.create () in
  {
    client;
    accepts;
    timeout_ms;
    trace;
    on_refused;
    on_cancel;
    held = None;
    waiting = false;
    release = None;
    wake = Promise.create ();
    stopped;
    stop_now;
  }

let stopped t = Promise.is_resolved t.stopped

let wake t =
  if not (Promise.is_resolved (fst t.wake)) then Promise.resolve (snd t.wake) ()

let listen t =
  if Option.is_none t.release then (
    let queued = B.name B.Channels.job_queued in
    let cancel = B.name B.Channels.job_cancel_requested in
    let receive = function
      | Ok (Wire_stream.Frame { route; payload; _ }) when route.channel = queued
        -> (
          match payload with
          | Error _ -> wake t
          | Ok value ->
              if
                Worker.accepts ~filters:t.accepts
                  ~announcement:(Yojson.Safe.from_string (B.encode value))
              then wake t)
      | Error (Wire_stream.Invalid_frame (Some route, _))
        when route.channel = queued ->
          wake t
      | Ok (Wire_stream.Frame { route; payload = Ok value; _ })
        when route.channel = cancel ->
          Option.iter
            (fun job ->
              let payload = Yojson.Safe.from_string (B.encode value) in
              if
                Yojson.Safe.Util.member "jobId" payload
                = `String (Worker.id job)
              then t.on_cancel job)
            t.held
      | _ -> ()
    in
    t.release <- Some (Client_core.on_frame t.client receive);
    let bus = Client_core.subscription t.client in
    Fiber.fork_daemon ~sw:(Client_core.switch t.client) (fun () ->
        Fiber.first
          (fun () -> Promise.await t.stopped)
          (fun () ->
            let rec watch previous seen_open =
              match S.await_state_change bus ~from:previous with
              | S.Closed -> ()
              | state ->
                  if seen_open && state = S.Open then wake t;
                  watch state (seen_open || state = S.Open)
            in
            let state = S.state bus in
            watch state (state = S.Open));
        Option.iter (fun release -> release ()) t.release;
        `Stop_daemon))

let next t =
  if t.waiting then invalid_arg "claims already have a waiting consumer";
  if stopped t then None
  else (
    listen t;
    t.waiting <- true;
    let bus = Client_core.subscription t.client in
    let next () =
      Option.iter Worker.await_settled t.held;
      t.held <- None;
      let rec claim () =
        t.wake <- Promise.create ();
        let result =
          try
            Worker.claim ?timeout_ms:t.timeout_ms ?trace:(t.trace ()) bus
              (Client_core.http t.client)
              ~client_id:(Client_core.client_id t.client)
              ~correlation_id:(Client_core.next_key t.client)
              ~accepts:t.accepts ()
          with Http_wire.Failed failure -> Worker.Refused (Some failure.code)
        in
        match result with
        | Worker.Held job ->
            t.held <- Some job;
            Some job
        | Worker.Empty ->
            Promise.await (fst t.wake);
            claim ()
        | Worker.Refused reason ->
            t.on_refused reason;
            Promise.await (fst t.wake);
            claim ()
      in
      claim ()
    in
    Fun.protect
      ~finally:(fun () -> t.waiting <- false)
      (fun () ->
        Fiber.first next (fun () ->
            Fiber.first
              (fun () -> Promise.await t.stopped)
              (fun () -> S.await_closed bus);
            None)))

let stop ?(settle = true) t =
  if not (stopped t) then (
    Promise.resolve t.stop_now ();
    Option.iter (fun release -> release ()) t.release;
    if settle then
      Option.iter
        (fun job ->
          Worker.fail job ~error:"worker stopped" ~failure_class:None
            ~completed:None ~cursors:None)
        t.held;
    t.held <- None)

let job_claim_channels = Worker.channels
let job_commit_channels = Worker.commit_channels
let will_retry_after = Worker.will_retry_after
