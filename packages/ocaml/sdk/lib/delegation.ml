open Eio.Std
module B = Bus_registry
module S = Subscription
module H = Http_wire
module J = Yojson.Safe.Util

type release = unit -> unit
type report_kind = Created | Progress | Complete | Retrying | Refused

type failure = {
  code : string;
  message : string option;
  failure_class : Enums.Failure_class.t option;
}

type listener = {
  receive : string -> (Yojson.Safe.t, Yojson.Safe.t) result -> unit;
  finish : unit -> unit;
}

type t = {
  sw : Switch.t;
  clock : Clock.t;
  subscription : Subscription.t;
  http : Http_wire.t;
  client_id : string;
  correlation_id : unit -> string;
  silence_ms : int;
  poll_ms : int;
  listeners : (int, listener) Hashtbl.t;
  mutable closed : bool;
  mutable next : int;
}

let make ?(silence_ms = Client_timing.job_silence_ms)
    ?(poll_ms = Client_timing.job_status_poll_ms) ~sw ~clock ~subscription ~http
    ~client_id ~correlation_id () =
  {
    sw;
    clock;
    subscription;
    http;
    client_id;
    correlation_id;
    silence_ms;
    poll_ms;
    listeners = Hashtbl.create 4;
    closed = false;
    next = 0;
  }

let text value = `String value
let field = J.member
let string key value = J.to_string (field key value)

let job_signals =
  let open B.Channels in
  [ B.Channel job_report_progress; B.Channel job_complete; B.Channel job_fail ]

let channels =
  let replies (B.Operation op) =
    [ B.Channel (B.result op); B.Channel (B.failure op) ]
  in
  job_signals
  @ List.concat_map replies
      [
        B.Operation B.Operations.job_create;
        B.Operation B.Operations.job_status_requested;
        B.Operation B.Operations.job_cancel_requested;
      ]

let job_channel channel =
  List.exists (fun (B.Channel value) -> B.name value = channel) job_signals

let on_frame t event =
  let dispatch channel signal =
    Hashtbl.to_seq_values t.listeners
    |> List.of_seq
    |> List.iter (fun listener -> listener.receive channel signal)
  in
  match Wire_stream.normalized event with
  | Ok (Wire_stream.Frame { route; payload = Ok value; _ })
    when job_channel route.channel ->
      dispatch route.channel (Ok (Yojson.Safe.from_string (B.encode value)))
  | Error { route = Some route; member; reason } when job_channel route.channel
    ->
      dispatch route.channel
        (Error
           (`Assoc
              [
                ("channel", text route.channel);
                ("member", text member);
                ( "reason",
                  text
                    (match reason with
                    | `Lacks -> "lacks"
                    | `Malformed -> "malformed") );
              ]))
  | _ -> ()

let send t ~correlation_id channel payload =
  ignore
    (H.emit t.http ~client_id:t.client_id ~correlation_id channel
       (Yojson.Safe.to_string payload))

let request t operation payload =
  let correlation_id = t.correlation_id () in
  let send () = send t ~correlation_id (B.request operation) payload in
  try
    match S.request t.subscription ~correlation_id operation ~send with
    | Ok (S.Result value) ->
        Ok (Yojson.Safe.from_string (B.encode value) |> field "response")
    | Ok (S.Failure value) -> Error (H.bus_failure value)
    | Error S.Timeout -> Error "bus.timeout"
    | Error S.Transport_closed -> Error "bus.closed"
    | Error S.Unsubscribed -> Error "bus.unsubscribed"
    | Error S.Unrecognized_failure -> Error "bus.rejected"
    | Error _ -> Error "error"
  with H.Failed failure -> Error failure.code

let start_open t ~verb ?resource ?stall_ms ~params ~on_report ~on_failure
    ~on_close () =
  let listener = t.next in
  t.next <- listener + 1;
  let pending = Queue.create () in
  let job_id = ref None in
  let finished = ref false in
  let retrying = ref false in
  let polling = ref false in
  let last_seen = ref (Clock.monotonic_now t.clock) in

  let stopped, stop = Promise.create () in
  let finish () =
    if not !finished then (
      finished := true;
      Hashtbl.remove t.listeners listener;
      Fun.protect ~finally:(fun () -> Promise.resolve stop ()) on_close)
  in
  let fail code payload =
    let failure_class =
      match field "failureClass" payload with
      | `String value -> Enums.Failure_class.of_string value
      | _ -> None
    in
    let message =
      match field "error" payload with
      | `String message -> Some message
      | _ -> None
    in
    on_failure { code; message; failure_class };
    finish ()
  in
  let receive channel signal =
    if not !finished then
      match (!job_id, signal) with
      | None, _ -> Queue.add (channel, signal) pending
      | Some _, Error detail -> on_report Refused detail
      | Some id, Ok (`Assoc fields as payload)
        when field "jobId" payload = text id -> (
          let payload = `Assoc (List.remove_assoc "_roles" fields) in
          last_seen := Clock.monotonic_now t.clock;
          match channel with
          | "job:report-progress" ->
              retrying := false;
              polling := false;
              on_report Progress (field "progress" payload)
          | "job:complete" ->
              on_report Complete payload;
              finish ()
          | "job:fail" when field "willRetry" payload = `Bool true ->
              retrying := true;
              on_report Retrying payload
          | "job:fail" -> fail "job.failed" payload
          | _ -> ())
      | _ -> ()
  in

  Hashtbl.add t.listeners listener { receive; finish };
  let span milliseconds = Mtime.Span.(max 1 milliseconds * ms) in
  let sleep until duration =
    Clock.sleep_until t.clock
      (Option.value (Mtime.add_span until duration) ~default:Mtime.max_stamp)
  in
  let stall = stall_ms in
  Fiber.fork_daemon ~sw:t.sw (fun () ->
      Fiber.first
        (fun () ->
          let payload =
            `Assoc
              ([ ("jobType", text verb); ("params", params) ]
              @ Option.to_list
                  (Option.map
                     (fun value -> ("resourceId", text value))
                     resource))
          in
          match request t B.Operations.job_create payload with
          | Error code -> if not !finished then fail code (`Assoc [])
          | Ok created when not !finished ->
              let id = string "jobId" created in
              job_id := Some id;
              last_seen := Clock.monotonic_now t.clock;
              on_report Created created;
              Queue.iter
                (fun (channel, signal) -> receive channel signal)
                pending;
              Queue.clear pending;
              let identity = `Assoc [ ("jobId", text id) ] in
              let poll_delay () =
                if !retrying || !polling then t.poll_ms else t.silence_ms
              in
              let rec monitor () =
                if not !finished then (
                  let delay_ms = poll_delay () in
                  let timeout =
                    Option.fold ~none:delay_ms ~some:(min delay_ms) stall
                  in
                  sleep !last_seen (span timeout);
                  if not !finished then
                    let elapsed =
                      Mtime.span (Clock.monotonic_now t.clock) !last_seen
                    in
                    if
                      Option.fold ~none:false
                        ~some:(fun ms ->
                          Mtime.Span.compare elapsed (span ms) >= 0)
                        stall
                    then (
                      (try
                         ignore
                           (send t ~correlation_id:(t.correlation_id ())
                              B.Channels.job_cancel_requested identity)
                       with H.Failed _ -> ());
                      if not !finished then fail "job.stalled" (`Assoc []))
                    else if
                      Mtime.Span.compare elapsed (span (poll_delay ())) < 0
                    then monitor ()
                    else
                      let previous_activity = !last_seen in
                      let status =
                        request t B.Operations.job_status_requested identity
                      in
                      if not !finished then (
                        (match status with
                        | Ok value -> (
                            match field "status" value with
                            | `String "complete" ->
                                on_report Complete
                                  (`Assoc
                                     ([
                                        ("jobId", text id);
                                        ("jobType", text verb);
                                      ]
                                     @ Option.to_list
                                         (Option.map
                                            (fun value ->
                                              ("resourceId", text value))
                                            resource)));
                                finish ()
                            | `String "failed" -> fail "job.failed" value
                            | `String "cancelled" -> fail "job.cancelled" value
                            | _ -> ())
                        | Error _ -> ());
                        if Mtime.equal !last_seen previous_activity then (
                          last_seen := Clock.monotonic_now t.clock;
                          polling := true);
                        monitor ()))
              in
              monitor ()
          | Ok _ -> ())
        (fun () -> Promise.await stopped);
      `Stop_daemon);
  finish

let start t ~verb ?resource ?stall_ms ~params ~on_report ~on_failure ~on_close
    () =
  if t.closed then (
    on_failure { code = "bus.closed"; message = None; failure_class = None };
    on_close ();
    Fun.id)
  else
    start_open t ~verb ?resource ?stall_ms ~params ~on_report ~on_failure
      ~on_close ()

let close t =
  t.closed <- true;
  Hashtbl.to_seq_values t.listeners
  |> List.of_seq
  |> List.iter (fun listener -> listener.finish ())
