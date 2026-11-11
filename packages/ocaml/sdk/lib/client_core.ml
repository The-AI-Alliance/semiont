open Eio.Std

type t = {
  sw : Switch.t;
  clock : Clock.t;
  cache : (Live_query.key, Yojson.Safe.t) Live_query.t;
  flush_cache : unit -> unit;
  session : Session.t;
  http : Http_wire.t;
  bus : Subscription.t;
  delegation : Delegation.t;
  client_id : string;
  key : unit -> string;
  on_event : (Wire_stream.frame, Wire_stream.refusal) result -> unit;
  error_listeners : (Http_wire.failure -> unit) list ref;
  listeners :
    ((Wire_stream.frame, Wire_stream.refusal) result -> unit) ref list ref;
}

let connect ?timing ?http_timing ?telemetry ?delegation_silence_ms
    ?delegation_poll_ms ?invalidation_window_ms ?restore ?save ?persister ~sw
    ~clock ~session ~client_id ~key ~call ~global ~on_event ~on_error () =
  let restore, save =
    match (persister, restore, save) with
    | Some store, None, None -> (Some (Storage_persister.restore store), None)
    | None, _, _ -> (restore, save)
    | _ -> invalid_arg "choose either a cache persister or individual hooks"
  in
  let error_listeners = ref [] in
  let report failure =
    List.iter (fun observe -> observe failure) (List.rev !error_listeners);
    on_error failure
  in
  let http =
    Http_wire.make ?timing:http_timing ?telemetry ~clock ~session ~key
      ~on_error:report ~call ()
  in
  let follower = ref None in
  let live = ref None in
  let listeners = ref [] in
  let deliver frame =
    (match Wire_stream.normalized frame with
    | Error { route = None; _ } ->
        report { Http_wire.code = "error"; status = None }
    | _ -> ());
    List.iter (fun handler -> !handler frame) (List.rev !listeners);
    on_event frame
  in
  let connect =
    Subscription.authenticated
      ~credential:(fun () -> Session.credential session)
      ~renew:(Session.refresh_refused session)
      ~on_refused:(fun status ->
        report { Http_wire.code = "unauthorized"; status = Some status })
      (Http_wire.subscribe http)
  in
  let on_event frame =
    Option.iter
      (fun delegation -> Delegation.on_frame delegation frame)
      !follower;
    Option.iter (fun cache -> Client_query.on_frame cache frame) !live;
    deliver frame
  in
  let bus =
    Subscription.start ?timing ?telemetry
      ?positions:(Option.map Storage_persister.positions persister)
      ~sw ~clock ~client_id ~global ~scopes:[] ~connect ~on_event ()
  in
  let delegation =
    Delegation.make ?silence_ms:delegation_silence_ms
      ?poll_ms:delegation_poll_ms ~sw ~clock ~subscription:bus ~http ~client_id
      ~correlation_id:key ()
  in
  follower := Some delegation;
  let save, flush_cache =
    match persister with
    | None -> (save, ignore)
    | Some store ->
        let task = State_task.make () in
        let pending = ref [] in
        let flush ~advance =
          match !pending with
          | [] -> ()
          | changes ->
              pending := [];
              let positions =
                if not advance then []
                else
                  match !live with
                  | None -> []
                  | Some cache ->
                      Subscription.positions bus
                      |> List.filter (fun (scope, _) ->
                          Live_query.ready_for_replay cache scope changes)
              in
              Storage_persister.save_covered store ~positions changes
        in
        let schedule key value =
          pending := (key, value) :: List.remove_assoc key !pending;
          let due = State_task.deadline clock Client_timing.save_debounce_ms in
          State_task.replace task ~sw (fun current ->
              Clock.sleep_until clock due;
              if current () then flush ~advance:true)
        in
        ( Some schedule,
          fun () ->
            State_task.dispose task;
            flush ~advance:false )
  in
  let cache =
    Client_query.make ?window_ms:invalidation_window_ms ?restore ?save ~sw
      ~clock ~bus ~http ~client_id ~key ()
  in
  live := Some cache;
  Fiber.fork_daemon ~sw (fun () ->
      let rec monitor previous dropped =
        match Subscription.await_state_change bus ~from:previous with
        | Subscription.Closed ->
            flush_cache ();
            Live_query.close cache;
            `Stop_daemon
        | Subscription.Open ->
            if dropped then
              Live_query.refetch cache ~on:"reopened" ~payload:None;
            monitor Subscription.Open false
        | state -> monitor state (dropped || state = Subscription.Reconnecting)
      in
      monitor Subscription.Initial false);
  {
    sw;
    clock;
    cache;
    flush_cache;
    session;
    http;
    bus;
    delegation;
    client_id;
    key;
    on_event = deliver;
    listeners;
    error_listeners;
  }

let clock t = t.clock
let switch t = t.sw
let client_id t = t.client_id
let next_key t = t.key ()
let session t = t.session
let http t = t.http
let subscription t = t.bus
let delegation t = t.delegation

let emit t ?scope ?correlation_id channel payload =
  Http_wire.emit t.http ~client_id:t.client_id ?scope ?correlation_id channel
    payload

let request t ?timeout_ms ?normalize_refusals operation payload =
  let correlation_id = t.key () in
  let send () =
    ignore (emit t ~correlation_id (Bus_registry.request operation) payload)
  in
  Subscription.request t.bus ?timeout_ms ?normalize_refusals ~correlation_id
    operation ~send

let on_error t observe =
  let callback failure = observe failure in
  t.error_listeners := callback :: !(t.error_listeners);
  fun () ->
    t.error_listeners :=
      List.filter (fun existing -> existing != callback) !(t.error_listeners)

let close t =
  t.listeners := [];
  t.error_listeners := [];
  Fun.protect
    ~finally:(fun () ->
      Live_query.close t.cache;
      Fun.protect
        ~finally:(fun () -> Subscription.close t.bus)
        (fun () -> Delegation.close t.delegation))
    t.flush_cache

let await_closed t = Subscription.await_closed t.bus

type error =
  | Transport of Subscription.request_error
  | Refused of string
  | Http of Http_wire.failure

let ask t operation payload =
  try
    match request t operation (Bus_registry.encode payload) with
    | Ok (Subscription.Result reply) -> Ok reply
    | Ok (Subscription.Failure failure) ->
        Error (Refused (Http_wire.bus_failure failure))
    | Error error -> Error (Transport error)
  with Http_wire.Failed failure -> Error (Http failure)

let publish t ?correlation_id channel payload =
  if Subscription.state t.bus <> Subscription.Closed then
    t.on_event
      (Ok
         (Wire_stream.Frame
            {
              id = None;
              route =
                {
                  channel = Bus_registry.name channel;
                  scope = None;
                  correlation_id;
                };
              trace = None;
              channel;
              payload = Ok payload;
            }))

let signal t ?scope channel payload =
  ignore (emit t ?scope channel (Bus_registry.encode payload))

let drive t ?scope channel payload =
  try
    let body = emit t ?scope channel (Bus_registry.encode payload) in
    let value =
      match Yojson.Safe.from_string body with
      | `Assoc fields -> (
          match List.assoc_opt "subscribers" fields with
          | Some (`Int count) -> Some count
          | _ -> None)
      | _ -> None
    in
    Ok value
  with
  | Http_wire.Failed failure -> Error (Http failure)
  | Yojson.Json_error _ -> Ok None

type query = {
  cache : (Live_query.key, Yojson.Safe.t) Live_query.t;
  query_key : Live_query.key;
}

let query (t : t) query_key = { cache = t.cache; query_key }

let observe query ~on_state ~on_close =
  Live_query.observe query.cache query.query_key ~on_state ~on_close

let fresh query = Live_query.fresh query.cache query.query_key
let invalidate query = Live_query.invalidate query.cache query.query_key

type unsubscribe = unit -> unit

let on_frame t receive : unsubscribe =
  let handler = ref receive in
  if Subscription.state t.bus <> Subscription.Closed then
    t.listeners := handler :: !(t.listeners);
  fun () ->
    t.listeners := List.filter (fun other -> other != handler) !(t.listeners)

let on_channel t channel receive =
  on_frame t (function
    | Ok (Wire_stream.Frame { route; payload = Ok payload; _ })
      when route.channel = Bus_registry.name channel -> (
        match
          Bus_registry.decode_received channel (Bus_registry.encode payload)
        with
        | Ok value -> receive value
        | Error _ -> ())
    | _ -> ())

let content run =
  try Ok (run ()) with Http_wire.Failed failure -> Error (Http failure)
