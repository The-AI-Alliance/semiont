open Eio.Std

type renewal = Renewed of string | Refused | Unavailable

let claims token =
  match String.split_on_char '.' token with
  | [ _; payload; _ ] -> (
      match
        Base64.decode ~pad:false ~alphabet:Base64.uri_safe_alphabet payload
      with
      | Ok source -> (
          match Strict_json.parse source with
          | Ok (`Assoc fields) -> fields
          | _ -> [])
      | Error _ -> [])
  | _ -> []

let filter predicate = function
  | Some value when predicate value -> Some value
  | _ -> None

let timestamp name fields =
  match List.assoc_opt name fields with
  | Some (`Intlit literal | `Floatlit literal) ->
      filter Float.is_finite (float_of_string_opt literal)
  | _ -> None

let token_expiry token = timestamp "exp" (claims token)

let refresh_delay ~now token =
  let fields = claims token in
  Option.map
    (fun expiry ->
      let issued = Option.value (timestamp "iat" fields) ~default:now in
      let seconds ms = float ms /. 1000. in
      let margin =
        min
          (seconds Client_timing.refresh_before_exp_ms)
          (max 0. ((expiry -. issued) /. 2.))
      in
      max (seconds Client_timing.min_refresh_delay_ms) (expiry -. now -. margin))
    (timestamp "exp" fields)

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
  work : task Eio.Stream.t;
  mutable token : string option;
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
    t.pending <- None;
    (if task.generation == t.generation then
       match outcome with
       | Renewed bearer -> publish t (Some bearer)
       | Unavailable when t.keep_on_unavailable -> ()
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

let start ?(keep_on_unavailable = false) ~sw ~clock ~initial_token ~renew () =
  let stop, stop_now = Promise.create () in
  let closed, mark_closed = Promise.create () in
  let t =
    {
      clock;
      keep_on_unavailable;
      renew;
      work = Eio.Stream.create 1;
      token = initial_token;
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
