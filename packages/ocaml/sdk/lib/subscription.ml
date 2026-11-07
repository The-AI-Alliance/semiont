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

type timing = {
  stream_open_timeout_ms : int;
  reconnect_ms : int;
  max_reconnect_ms : int;
  degraded_threshold_ms : int;
  reconnect_debounce_ms : int;
  lazy_remove_ms : int;
  linger_ms : int;
  bus_request_timeout_ms : int;
}

let default_timing =
  {
    stream_open_timeout_ms = Client_timing.stream_open_timeout_ms;
    reconnect_ms = Client_timing.reconnect_ms;
    max_reconnect_ms = Client_timing.max_reconnect_ms;
    degraded_threshold_ms = Client_timing.degraded_threshold_ms;
    reconnect_debounce_ms = Client_timing.reconnect_debounce_ms;
    lazy_remove_ms = Client_timing.lazy_remove_ms;
    linger_ms = Client_timing.linger_ms;
    bus_request_timeout_ms = Client_timing.bus_request_timeout_ms;
  }

type open_error = Retry | Retry_after of int | No_credential

type credential_error =
  | Connect_failed
  | Connect_retry_after of int
  | Credential_refused of int

let authenticated ~credential ~renew ~on_refused connect =
  let refused = ref [] in
  let replacement = ref None in
  let rec attempt ~sw snapshot bearer may_renew =
    match connect ~sw snapshot ~bearer with
    | Ok reader ->
        refused := [];
        replacement := None;
        Ok reader
    | Error Connect_failed -> Error Retry
    | Error (Connect_retry_after ms) -> Error (Retry_after ms)
    | Error (Credential_refused status) -> (
        refused := bearer :: !refused;
        on_refused status;
        if not may_renew then Error No_credential
        else
          match renew ~refused:bearer with
          | Some bearer when not (List.mem bearer !refused) ->
              replacement := Some bearer;
              attempt ~sw snapshot bearer false
          | _ -> Error No_credential)
  in
  fun ~sw snapshot ->
    match credential () with
    | Some bearer when not (List.mem bearer !refused) ->
        let fresh = !replacement <> Some bearer in
        if fresh then (
          refused := [];
          replacement := None);
        attempt ~sw snapshot bearer fresh
    | _ -> Error No_credential

type ('result, 'failure) reply =
  | Result of 'result Bus_registry.decoded
  | Failure of 'failure Bus_registry.decoded

type request_error =
  | Transport_closed
  | Timeout
  | Duplicate_id
  | Unsubscribed
  | Unrecognized_failure
  | Invalid_reply of Bus_registry.decode_error
  | Invalid_frame of Models.decode_error

type t = {
  clock : Clock.t;
  timing : timing;
  telemetry : Telemetry.t option;
  client_id : string;
  global : Bus_registry.packed_channel list;
  scopes : (string, (unit ref * scope) list) Hashtbl.t;
  mutable scope_change : Mtime.t option;
  mutable scopes_changed : unit Promise.t * unit Promise.u;
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

let scope_channels holds =
  List.concat_map (fun (_, scope) -> scope.channels) holds
  |> List.sort_uniq
       (fun (Bus_registry.Channel left) (Bus_registry.Channel right) ->
         String.compare (Bus_registry.name left) (Bus_registry.name right))

let snapshot t =
  {
    client_id = t.client_id;
    global = t.global;
    scoped =
      Hashtbl.to_seq t.scopes |> List.of_seq
      |> List.sort (fun (left, _) (right, _) -> String.compare left right)
      |> List.filter_map (fun (key, holds) ->
          match holds with
          | [] -> None
          | (_, scope) :: _ ->
              Some
                ( { scope with channels = scope_channels holds },
                  Hashtbl.find_opt t.positions key ));
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

let rec await_state_change t ~from =
  if t.state <> from || t.state = Closed then t.state
  else (
    Promise.await (fst t.changed);
    await_state_change t ~from)

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

let schedule_scope_change t ~addition =
  let delay =
    if addition then t.timing.reconnect_debounce_ms else t.timing.lazy_remove_ms
  in
  let due = deadline t (float delay) in
  let due =
    match t.scope_change with
    | Some old when (not addition) && Mtime.compare old due < 0 -> old
    | _ -> due
  in
  t.scope_change <- Some due;
  let _, wake = t.scopes_changed in
  t.scopes_changed <- Promise.create ();
  Promise.resolve wake ()

let hold_scope t scope =
  let key = scope_key scope.resource in
  let current () = Option.value (Hashtbl.find_opt t.scopes key) ~default:[] in
  let token = ref () in
  let add = current () in
  let held = (token, scope) :: add in
  let changed left right =
    names (scope_channels left) <> names (scope_channels right)
  in
  if t.state <> Closed && not (Promise.is_resolved t.closing) then (
    Hashtbl.replace t.scopes key held;
    if changed add held then schedule_scope_change t ~addition:true);
  fun () ->
    let held = current () in
    let remaining = List.filter (fun (id, _) -> id != token) held in
    (match remaining with
    | [] -> Hashtbl.remove t.scopes key
    | _ -> Hashtbl.replace t.scopes key remaining);
    if t.state <> Closed && changed held remaining then
      schedule_scope_change t ~addition:false

let route = function
  | Ok (Wire_stream.Frame { route; _ }) -> Some route
  | Error (Wire_stream.Invalid_frame (route, _)) -> route
  | Error (Wire_stream.Unknown_channel _) -> None

let position id =
  match String.rindex_opt id '-' with
  | Some separator ->
      let digits =
        String.sub id (separator + 1) (String.length id - separator - 1)
      in
      if
        digits <> ""
        && String.for_all (function '0' .. '9' -> true | _ -> false) digits
      then Some (Z.of_string digits)
      else None
  | None -> None

let advance_position t scope id =
  let key = scope_key scope in
  match position id with
  | None -> ()
  | Some next ->
      let previous = Option.bind (Hashtbl.find_opt t.positions key) position in
      if
        Option.fold ~none:true
          ~some:(fun previous -> Z.gt next previous)
          previous
      then Hashtbl.replace t.positions key id

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
            advance_position t scope id
        | _ -> ());
        true)
  | _ -> true

let dispatch t event =
  if first_delivery t event then
    let deliver () =
      (match Option.bind (route event) (fun route -> route.correlation_id) with
      | Some id ->
          Option.iter
            (fun receive -> receive event)
            (Hashtbl.find_opt t.pending id)
      | None -> ());
      t.on_event event
    in
    match event with
    | Ok (Wire_stream.Frame { route; payload = Ok _; _ }) ->
        let open Telemetry_facts in
        let prefix, kind = bus_recv in
        let attributes =
          (attr_bus_channel, Telemetry.String route.channel)
          :: Option.to_list
               (Option.map
                  (fun scope ->
                    (attr_bus_scope, Telemetry.String (scope_key scope)))
                  route.scope)
        in
        Telemetry.around t.telemetry ~clock:t.clock
          (prefix ^ route.channel, kind)
          attributes deliver
    | _ -> deliver ()

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

let open_stream t sw snapshot =
  Fiber.first
    (fun () ->
      try t.connect ~sw snapshot with Eio.Io _ | End_of_file -> Error Retry)
    (fun () ->
      sleep t (float t.timing.stream_open_timeout_ms);
      Error Retry)

let scope_signature snapshot =
  List.map
    (fun (scope, _) -> (scope_key scope.resource, names scope.channels))
    snapshot.scoped

type stream = {
  scopes : (string * string list) list;
  ready : (unit, open_error) result Promise.t;
  ended : unit Promise.t;
  read : unit -> unit;
  stop : unit -> unit;
}

let spawn_stream t lifetime =
  t.scope_change <- None;
  let requested = snapshot t in
  let ready, opened = Promise.create () in
  let begin_read, read_now = Promise.create () in
  let stopping, stop_now = Promise.create () in
  let ended, mark_ended = Promise.create () in
  let resolve promise resolver =
    if not (Promise.is_resolved promise) then Promise.resolve resolver ()
  in
  Fiber.fork_daemon ~sw:lifetime (fun () ->
      Fun.protect
        ~finally:(fun () -> Promise.resolve mark_ended ())
        (fun () ->
          Fiber.first
            (fun () ->
              Switch.run @@ fun sw ->
              match open_stream t sw requested with
              | Error error -> Promise.resolve opened (Error error)
              | Ok input ->
                  Promise.resolve opened (Ok ());
                  Promise.await begin_read;
                  read_stream t input)
            (fun () -> Promise.await stopping));
      `Stop_daemon);
  {
    scopes = scope_signature requested;
    ready;
    ended;
    read = (fun () -> resolve begin_read read_now);
    stop = (fun () -> resolve stopping stop_now);
  }

let rec await_scope_change t =
  let changed = fst t.scopes_changed in
  match t.scope_change with
  | None ->
      Promise.await changed;
      await_scope_change t
  | Some due -> (
      match
        Fiber.first
          (fun () ->
            Clock.sleep_until t.clock due;
            `Due)
          (fun () ->
            Promise.await changed;
            `Changed)
      with
      | `Due -> if t.scope_change <> Some due then await_scope_change t
      | `Changed -> await_scope_change t)

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
      let degraded_at = deadline t (float t.timing.degraded_threshold_ms) in
      Fiber.fork_daemon ~sw:lifetime (fun () ->
          Fiber.first
            (fun () ->
              Clock.sleep_until t.clock degraded_at;
              if not (Promise.is_resolved restored) then set_state t Degraded)
            (fun () -> Promise.await restored);
          `Stop_daemon))
  in
  let activate stream =
    end_outage ();
    set_state t Open;
    stream.read ()
  in
  let backoff ?(minimum = 0) step =
    let delay = float step *. (0.5 +. (Clock.jitter t.clock *. 0.5)) in
    sleep t (max (float minimum) delay);
    min (step * 2) t.timing.max_reconnect_ms
  in
  let rec connect step =
    let stream = spawn_stream t lifetime in
    settle step stream
  and settle step stream =
    match Promise.await stream.ready with
    | Ok () ->
        activate stream;
        serve stream
    | Error No_credential ->
        end_outage ();
        set_state t Unauthenticated;
        sleep t (float t.timing.reconnect_ms);
        set_state t Connecting;
        connect t.timing.reconnect_ms
    | Error (Retry | Retry_after _) as error ->
        begin_outage ();
        let minimum =
          match error with Error (Retry_after ms) -> ms | _ -> 0
        in
        connect (backoff ~minimum step)
  and serve active =
    match
      Fiber.first
        (fun () ->
          Promise.await active.ended;
          `Dropped)
        (fun () ->
          await_scope_change t;
          `Replace)
    with
    | `Dropped ->
        begin_outage ();
        connect (backoff t.timing.reconnect_ms)
    | `Replace ->
        if active.scopes = scope_signature (snapshot t) then (
          t.scope_change <- None;
          serve active)
        else replace active
  and replace active =
    let candidate = spawn_stream t lifetime in
    match
      Fiber.first
        (fun () ->
          ignore (Promise.await candidate.ready);
          `Ready)
        (fun () ->
          Promise.await active.ended;
          `Dropped)
    with
    | `Dropped ->
        begin_outage ();
        settle t.timing.reconnect_ms candidate
    | `Ready -> (
        match Promise.await candidate.ready with
        | Error _ ->
            if Option.is_none t.scope_change then
              schedule_scope_change t ~addition:false;
            serve active
        | Ok () ->
            activate candidate;
            Fiber.fork_daemon ~sw:lifetime (fun () ->
                sleep t (float t.timing.linger_ms);
                active.stop ();
                `Stop_daemon);
            serve candidate)
  in
  set_state t Connecting;
  connect t.timing.reconnect_ms

let start ?(timing = default_timing) ?telemetry ~sw ~clock ~client_id ~global
    ~scopes ~connect ~on_event () =
  let closing, close_now = Promise.create () in
  let closed, mark_closed = Promise.create () in
  let t =
    {
      clock;
      timing;
      telemetry;
      client_id;
      global;
      scopes = Hashtbl.create 8;
      scope_change = None;
      scopes_changed = Promise.create ();
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
  List.iter
    (fun scope ->
      let key = scope_key scope.resource in
      let holds = Option.value (Hashtbl.find_opt t.scopes key) ~default:[] in
      Hashtbl.replace t.scopes key ((ref (), scope) :: holds))
    scopes;
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

let request t ?(timeout_ms = t.timing.bus_request_timeout_ms) ~correlation_id
    operation ~send =
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
                    Some
                      (match payload with
                      | Error
                          (Bus_registry.Invalid_payload { member = "code"; _ })
                        ->
                          Error Unrecognized_failure
                      | _ -> decode failure (fun value -> Failure value) payload)
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
