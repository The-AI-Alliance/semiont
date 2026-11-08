open Eio.Std

type renewal = Renewed of string | Refused | Unavailable

let filter predicate = function
  | Some value when predicate value -> Some value
  | _ -> None

let token_expiry = Tokens.token_expiry
let refresh_delay = Tokens.refresh_delay

type task = {
  refused : string option;
  generation : unit ref;
  result : renewal Promise.t;
  complete : renewal Promise.u;
}

type t = {
  clock : Clock.t;
  keep_on_unavailable : bool;
  renew : refused:string option -> renewal;
  on_rejected : string -> unit;
  work : task Eio.Stream.t;
  mutable token : string option;
  mutable managed :
    (current:(unit -> bool) -> refused:string option -> renewal -> renewal)
    option;
  mutable retry_due : bool;
  mutable generation : unit ref;
  mutable changed : unit Promise.t * unit Promise.u;
  mutable pending : task option;
  stop : unit Promise.t;
  stop_now : unit Promise.u;
  closed : unit Promise.t;
}

let active t = not (Promise.is_resolved t.stop || Promise.is_resolved t.closed)
let credential t = if active t then t.token else None

let publish t token =
  t.token <- token;
  let _, notify = t.changed in
  t.changed <- Promise.create ();
  Promise.resolve notify ()

let replace t token =
  if active t then (
    t.generation <- ref ();
    t.retry_due <- false;
    publish t token)

let renew_once t refused =
  if not (active t) then Unavailable
  else
    let task =
      match t.pending with
      | Some task -> task
      | None ->
          let result, complete = Promise.create () in
          let task = { refused; generation = t.generation; result; complete } in
          t.pending <- Some task;
          Eio.Stream.add t.work task;
          task
    in
    Fiber.first
      (fun () -> Promise.await task.result)
      (fun () ->
        Promise.await t.closed;
        Unavailable)

let refresh_refused t ~refused =
  match credential t with
  | Some bearer when bearer <> refused -> Some bearer
  | _ ->
      ignore (renew_once t (Some refused));
      filter (fun bearer -> bearer <> refused) (credential t)

let worker t =
  while true do
    let task = Eio.Stream.take t.work in
    let outcome =
      try t.renew ~refused:task.refused with Eio.Io _ -> Unavailable
    in
    let outcome =
      match t.managed with
      | Some validate when task.generation == t.generation ->
          validate
            ~current:(fun () -> active t && task.generation == t.generation)
            ~refused:task.refused outcome
      | _ -> outcome
    in
    t.pending <- None;
    if task.generation == t.generation then (
      t.retry_due <- outcome = Unavailable && Option.is_some t.managed;
      match outcome with
      | Renewed bearer -> publish t (Some bearer)
      | Unavailable when t.keep_on_unavailable && t.managed = None -> ()
      | Refused | Unavailable -> publish t None);
    Promise.resolve task.complete outcome
  done

let wait t seconds =
  let changed = fst t.changed in
  let elapsed () =
    let nanos = seconds *. 1_000_000_000. in
    let due =
      if nanos >= Int64.to_float Int64.max_int then Mtime.max_stamp
      else
        Mtime.add_span
          (Clock.monotonic_now t.clock)
          (Mtime.Span.of_uint64_ns (Int64.of_float nanos))
        |> Option.value ~default:Mtime.max_stamp
    in
    Clock.sleep_until t.clock due;
    not (Promise.is_resolved changed)
  in
  Fiber.first elapsed (fun () ->
      Promise.await changed;
      false)

let schedule t =
  let rec loop () =
    if t.retry_due then retry t.generation Client_timing.reconnect_ms
    else
      match
        Option.bind (credential t) (refresh_delay ~now:(Clock.wall_now t.clock))
      with
      | None ->
          Promise.await (fst t.changed);
          loop ()
      | Some delay ->
          if wait t delay then
            let generation = t.generation in
            match renew_once t None with
            | Unavailable when generation == t.generation ->
                retry generation Client_timing.reconnect_ms
            | _ -> loop ()
          else loop ()
  and retry generation step =
    let delay = float step /. 1000. *. (0.5 +. (Clock.jitter t.clock *. 0.5)) in
    if wait t delay && generation == t.generation then
      match renew_once t None with
      | Unavailable when generation == t.generation ->
          retry generation (min (step * 2) Client_timing.max_reconnect_ms)
      | _ -> loop ()
    else loop ()
  in
  loop ()

let start ?(keep_on_unavailable = false) ?(on_rejected = ignore) ~sw ~clock
    ~initial_token ~renew () =
  let stop, stop_now = Promise.create () in
  let closed, mark_closed = Promise.create () in
  let t =
    {
      clock;
      keep_on_unavailable;
      renew;
      on_rejected;
      work = Eio.Stream.create 1;
      token = initial_token;
      managed = None;
      retry_due = false;
      generation = ref ();
      changed = Promise.create ();
      pending = None;
      stop;
      stop_now;
      closed;
    }
  in
  Fiber.fork_daemon ~sw (fun () ->
      Fun.protect
        ~finally:(fun () -> Promise.resolve mark_closed ())
        (fun () ->
          Fiber.first
            (fun () -> Fiber.both (fun () -> worker t) (fun () -> schedule t))
            (fun () -> Promise.await stop));
      `Stop_daemon);
  t

let close t = if active t then Promise.resolve t.stop_now ()
let await_closed t = Promise.await t.closed

let await_credential_change t ~from =
  let rec wait () =
    let current = credential t in
    if current <> from || not (active t) then current
    else
      Fiber.first
        (fun () ->
          Promise.await (fst t.changed);
          wait ())
        (fun () ->
          Promise.await t.stop;
          None)
  in
  wait ()

let refresh t =
  ignore (renew_once t None);
  credential t

let manage t validate = t.managed <- Some validate
let refresh_outcome t = renew_once t None
let forget t token = t.on_rejected token
