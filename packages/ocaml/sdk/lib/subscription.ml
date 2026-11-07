open Eio.Std

type state =
  | Initial
  | Connecting
  | Open
  | Reconnecting
  | Degraded
  | Unauthenticated
  | Closed

type scope = {
  resource : Identifiers.Resource_id.t;
  channels : Bus_registry.packed_channel list;
}

type snapshot = {
  client_id : string;
  global : Bus_registry.packed_channel list;
  scoped : (scope * string option) list;
  pending_replies : string list;
}

type open_error = Retry | No_credential

type ('result, 'failure) reply =
  | Result of 'result Bus_registry.decoded
  | Failure of 'failure Bus_registry.decoded

type request_error =
  | Transport_closed
  | Timeout
  | Duplicate_id
  | Unsubscribed
  | Invalid_reply of Bus_registry.decode_error
  | Invalid_frame of Models.decode_error

type t = {
  clock : Clock.t;
  client_id : string;
  global : Bus_registry.packed_channel list;
  scopes : scope list;
  connect : sw:Switch.t -> snapshot -> (Eio.Buf_read.t, open_error) result;
  on_event : (Wire_stream.frame, Wire_stream.refusal) result -> unit;
  positions : (string, string) Hashtbl.t;
  seen : (string, unit) Hashtbl.t;
  recent : string Queue.t;
  pending :
    (string, (Wire_stream.frame, Wire_stream.refusal) result -> unit) Hashtbl.t;
  closing : unit Promise.t;
  close_now : unit Promise.u;
  closed : unit Promise.t;
  mutable state : state;
  mutable changed : unit Promise.t * unit Promise.u;
}

let names =
  List.map (fun (Bus_registry.Channel channel) -> Bus_registry.name channel)

let string value = `Stringlit (Yojson.Safe.to_string (`String value))
let strings values = `List (List.map string values)
let scope_key scope = Identifiers.Resource_id.to_string scope

let encode_subscription snapshot =
  let scoped =
    List.map
      (fun (scope, last) ->
        let fields =
          [
            ("scope", string (scope_key scope.resource));
            ("channels", strings (names scope.channels));
          ]
        in
        let fields =
          match last with
          | None -> fields
          | Some id -> ("lastEventId", string id) :: fields
        in
        `Assoc fields)
      snapshot.scoped
  in
  let raw =
    `Assoc
      [
        ("clientId", string snapshot.client_id);
        ("global", strings (names snapshot.global));
        ("scoped", `List scoped);
        ("pendingReplies", strings snapshot.pending_replies);
      ]
  in
  Result.map Models.encode
    (Models.decode Models.bus_subscribe_request (Yojson.Raw.to_string raw))

let snapshot t =
  {
    client_id = t.client_id;
    global = t.global;
    scoped =
      List.map
        (fun scope ->
          (scope, Hashtbl.find_opt t.positions (scope_key scope.resource)))
        t.scopes;
    pending_replies =
      Hashtbl.to_seq_keys t.pending |> List.of_seq |> List.sort String.compare;
  }

let set_state t state =
  if t.state <> state then (
    t.state <- state;
    let _, wake = t.changed in
    t.changed <- Promise.create ();
    Promise.resolve wake ())

let state t = t.state

let close t =
  if not (Promise.is_resolved t.closing) then Promise.resolve t.close_now ()

let await_closed t = Promise.await t.closed

let after start milliseconds =
  let span =
    Mtime.Span.of_uint64_ns (Int64.of_float (milliseconds *. 1_000_000.))
  in
  match Mtime.add_span start span with
  | Some time -> time
  | None -> Mtime.max_stamp

let deadline t milliseconds = after (Clock.monotonic_now t.clock) milliseconds
let sleep t milliseconds = Clock.sleep_until t.clock (deadline t milliseconds)

let route = function
  | Ok (Wire_stream.Frame { route; _ }) -> Some route
  | Error (Wire_stream.Invalid_frame (route, _)) -> route
  | Error (Wire_stream.Unknown_channel _) -> None

let first_delivery t = function
  | Ok (Wire_stream.Frame { id = Some id; route; channel; payload; _ }) ->
      if Hashtbl.mem t.seen id then false
      else (
        Hashtbl.add t.seen id ();
        Queue.add id t.recent;
        if Queue.length t.recent > Client_timing.seen_event_ids_count then
          Hashtbl.remove t.seen (Queue.take t.recent);
        (match (Bus_registry.delivery channel, route.scope, payload) with
        | Some Bus_registry.Positioned, Some scope, Ok _ ->
            Hashtbl.replace t.positions (scope_key scope) id
        | _ -> ());
        true)
  | _ -> true

let dispatch t event =
  if first_delivery t event then (
    (match Option.bind (route event) (fun route -> route.correlation_id) with
    | Some id ->
        Option.iter
          (fun receive -> receive event)
          (Hashtbl.find_opt t.pending id)
    | None -> ());
    t.on_event event)

let read_stream t input =
  let rec loop () =
    if Promise.is_resolved t.closing then ()
    else
      match Wire_stream.read input with
      | exception Eio.Io _ -> ()
      | None -> ()
      | Some event ->
          dispatch t event;
          loop ()
  in
  loop ()

let open_stream t sw =
  Fiber.first
    (fun () -> try t.connect ~sw (snapshot t) with Eio.Io _ -> Error Retry)
    (fun () ->
      sleep t (float Client_timing.stream_open_timeout_ms);
      Error Retry)

let run t =
  Switch.run @@ fun lifetime ->
  let recovered = ref None in
  let end_outage () =
    Option.iter (fun wake -> Promise.resolve wake ()) !recovered;
    recovered := None
  in
  let begin_outage () =
    if Option.is_none !recovered then (
      set_state t Reconnecting;
      let restored, restore = Promise.create () in
      recovered := Some restore;
      let degraded_at =
        deadline t (float Client_timing.degraded_threshold_ms)
      in
      Fiber.fork_daemon ~sw:lifetime (fun () ->
          Fiber.first
            (fun () ->
              Clock.sleep_until t.clock degraded_at;
              if not (Promise.is_resolved restored) then set_state t Degraded)
            (fun () -> Promise.await restored);
          `Stop_daemon))
  in
  let rec loop step =
    let outcome =
      Switch.run @@ fun sw ->
      match open_stream t sw with
      | Error error -> `Refused error
      | Ok input ->
          end_outage ();
          set_state t Open;
          read_stream t input;
          `Dropped
    in
    if not (Promise.is_resolved t.closing) then
      match outcome with
      | `Refused No_credential ->
          end_outage ();
          set_state t Unauthenticated;
          sleep t (float Client_timing.reconnect_ms);
          set_state t Connecting;
          loop Client_timing.reconnect_ms
      | `Dropped | `Refused Retry ->
          begin_outage ();
          let step =
            if outcome = `Dropped then Client_timing.reconnect_ms else step
          in
          let delay = float step *. (0.5 +. (Clock.jitter t.clock *. 0.5)) in
          sleep t delay;
          loop (min (step * 2) Client_timing.max_reconnect_ms)
  in
  set_state t Connecting;
  loop Client_timing.reconnect_ms

let start ~sw ~clock ~client_id ~global ~scopes ~connect ~on_event () =
  let closing, close_now = Promise.create () in
  let closed, mark_closed = Promise.create () in
  let t =
    {
      clock;
      client_id;
      global;
      scopes;
      connect;
      on_event;
      positions = Hashtbl.create 8;
      seen = Hashtbl.create Client_timing.seen_event_ids_count;
      recent = Queue.create ();
      pending = Hashtbl.create 8;
      closing;
      close_now;
      closed;
      state = Initial;
      changed = Promise.create ();
    }
  in
  Fiber.fork_daemon ~sw (fun () ->
      Fun.protect
        ~finally:(fun () ->
          set_state t Closed;
          Promise.resolve mark_closed ())
        (fun () ->
          Fiber.first (fun () -> run t) (fun () -> Promise.await closing));
      `Stop_daemon);
  t

let rec await_open t =
  if Promise.is_resolved t.closing then Error Transport_closed
  else
    match t.state with
    | Open -> Ok ()
    | Closed -> Error Transport_closed
    | _ ->
        Promise.await (fst t.changed);
        await_open t

let request t ?(timeout_ms = Client_timing.bus_request_timeout_ms)
    ~correlation_id operation ~send =
  let result = Bus_registry.result operation in
  let failure = Bus_registry.failure operation in
  let result_name = Bus_registry.name result in
  let failure_name = Bus_registry.name failure in
  let globals = names t.global in
  let expires = deadline t (float (max 0 timeout_ms)) in
  let wait () =
    match await_open t with
    | Error error -> Error error
    | Ok () ->
        if Mtime.compare (Clock.monotonic_now t.clock) expires >= 0 then
          Error Timeout
        else if Hashtbl.mem t.pending correlation_id then Error Duplicate_id
        else
          let reply, settle = Promise.create () in
          let decode channel wrap = function
            | Error fault -> Error (Invalid_reply fault)
            | Ok payload ->
                Result.map wrap
                  (Bus_registry.decode channel (Bus_registry.encode payload))
                |> Result.map_error (fun fault -> Invalid_reply fault)
          in
          let receive event =
            if
              (not (Promise.is_resolved reply))
              && Mtime.compare (Clock.monotonic_now t.clock) expires < 0
            then (
              let matched =
                match event with
                | Ok (Wire_stream.Frame { route; payload; _ })
                  when route.channel = result_name ->
                    Some (decode result (fun value -> Result value) payload)
                | Ok (Wire_stream.Frame { route; payload; _ })
                  when route.channel = failure_name ->
                    Some (decode failure (fun value -> Failure value) payload)
                | Error (Wire_stream.Invalid_frame (Some route, fault))
                  when route.channel = result_name
                       || route.channel = failure_name ->
                    Some (Error (Invalid_frame fault))
                | _ -> None
              in
              Option.iter (Promise.resolve settle) matched;
              if Option.is_some matched then
                Hashtbl.remove t.pending correlation_id)
          in
          Hashtbl.add t.pending correlation_id receive;
          Fun.protect
            ~finally:(fun () ->
              match Hashtbl.find_opt t.pending correlation_id with
              | Some active when active == receive ->
                  Hashtbl.remove t.pending correlation_id
              | _ -> ())
            (fun () ->
              send ();
              Promise.await reply)
  in
  if t.state = Closed || Promise.is_resolved t.closing then
    Error Transport_closed
  else if not (List.mem result_name globals && List.mem failure_name globals)
  then Error Unsubscribed
  else
    Fiber.first
      (fun () ->
        Fiber.first wait (fun () ->
            Clock.sleep_until t.clock expires;
            Error Timeout))
      (fun () ->
        await_closed t;
        Error Transport_closed)
