module B = Bus_registry
module J = Yojson.Safe.Util

type phase = Claimed | Started | Settled

type held = {
  http : Http_wire.t;
  client_id : string;
  metadata : Yojson.Safe.t;
  params : Yojson.Safe.t;
  job_id : Identifiers.Job_id.t;
  resource : Identifiers.Resource_id.t;
  verb : Enums.Job_type.t;
  retry_count : int;
  max_retries : int;
  lock : Eio.Mutex.t;
  mutable phase : phase;
}

type claim = Held of held | Empty | Refused of string option

let channels =
  let open B.Channels in
  [
    B.Channel job_cancel_requested;
    B.Channel job_claim_failed;
    B.Channel job_claimed;
    B.Channel job_queued;
  ]

let string name value = J.member name value |> J.to_string
let int name value = J.member name value |> J.to_int

let optional name value =
  match J.member name value with `Null -> None | value -> Some value

let text value = `String value
let id job = Identifiers.Job_id.to_string job.job_id
let kind job = Enums.Job_type.to_string job.verb

let accepts ~filters ~announcement =
  let verb = J.member "jobType" announcement in
  let motivation value =
    match J.member "params" value with
    | `Assoc _ as params -> J.member "motivation" params
    | _ -> `Null
  in
  J.to_list filters
  |> List.exists (fun filter ->
      J.member "jobType" filter = verb
      &&
      match verb with
      | `String "yield" -> true
      | `String "mark" ->
          let wanted = motivation filter in
          wanted <> `Null && wanted = motivation announcement
      | _ -> false)

let claim subscription http ~client_id ~correlation_id
    ?(timeout_ms = Client_timing.job_claim_timeout_ms) ~accepts () =
  let operation = B.Operations.job_claim in
  let send () =
    ignore
      (Http_wire.emit http ~client_id ~correlation_id (B.request operation)
         (Yojson.Safe.to_string (`Assoc [ ("accepts", accepts) ])))
  in
  match
    Subscription.request subscription ~timeout_ms ~correlation_id operation
      ~send
  with
  | Error Subscription.Timeout -> Refused (Some "bus.timeout")
  | Error _ -> Refused None
  | Ok (Subscription.Failure payload) ->
      let code = Http_wire.bus_failure payload in
      if code = "bus.none-pending" then Empty else Refused (Some code)
  | Ok (Subscription.Result payload) -> (
      try
        let response =
          J.member "response" (Yojson.Safe.from_string (B.encode payload))
        in
        let metadata = J.member "metadata" response in
        let params = J.member "params" response in
        let job_id =
          Result.get_ok (Identifiers.Job_id.of_string (string "id" metadata))
        in
        let resource =
          Result.get_ok
            (Identifiers.Resource_id.of_string (string "resourceId" params))
        in
        let verb =
          Option.get (Enums.Job_type.of_string (string "type" metadata))
        in
        Held
          {
            http;
            client_id;
            metadata;
            params;
            job_id;
            resource;
            verb;
            retry_count = int "retryCount" metadata;
            max_retries = int "maxRetries" metadata;
            lock = Eio.Mutex.create ();
            phase = Claimed;
          }
      with J.Type_error _ | Invalid_argument _ -> Refused None)

let view job =
  let default name fallback =
    Option.value (optional name job.metadata) ~default:fallback
  in
  `Assoc
    [
      ("jobId", text (id job));
      ("jobType", text (kind job));
      ("resourceId", text (Identifiers.Resource_id.to_string job.resource));
      ("params", job.params);
      ("completedUnits", default "completedUnits" (`List []));
      ("unitCursors", default "unitCursors" (`Assoc []));
      ("retryCount", `Int job.retry_count);
      ("maxRetries", `Int job.max_retries);
    ]

let identity job =
  [
    ("resourceId", text (Identifiers.Resource_id.to_string job.resource));
    ("jobId", text (id job));
    ("jobType", text (kind job));
  ]

let send job channel fields =
  ignore
    (Http_wire.emit job.http ~client_id:job.client_id channel
       (Yojson.Safe.to_string (`Assoc fields)))

let lifecycle job channel fields =
  send job channel
    ((("attempt", `Int (job.retry_count + 1)) :: identity job) @ fields)

let locked job f = Eio.Mutex.use_rw ~protect:false job.lock f

let start job =
  locked job (fun () ->
      if job.phase = Claimed then (
        lifecycle job B.Channels.job_start [];
        job.phase <- Started))

let running job f = locked job (fun () -> if job.phase = Started then f ())

let progress job ~percentage ~message =
  running job (fun () ->
      let percentage = `Int percentage in
      let detail =
        ("percentage", percentage)
        :: Option.to_list (Option.map (fun value -> ("message", value)) message)
      in
      lifecycle job B.Channels.job_report_progress
        [ ("percentage", percentage); ("progress", `Assoc detail) ])

let checkpoint job ~completed ~cursors =
  running job (fun () ->
      send job B.Channels.job_checkpoint
        [
          ("jobId", text (id job));
          ("completedUnits", completed);
          ("unitCursors", cursors);
        ])

let settle job send =
  locked job (fun () ->
      if job.phase <> Settled then (
        send ();
        job.phase <- Settled))

let complete job result =
  settle job (fun () ->
      lifecycle job B.Channels.job_complete [ ("result", result) ])

let cancel job ~completed =
  settle job (fun () ->
      send job B.Channels.job_cancel
        (identity job
        @ Option.to_list
            (Option.map (fun value -> ("completedUnits", value)) completed)))

let fail job ~error ~failure_class ~completed ~cursors =
  let optional name value = Option.map (fun value -> (name, value)) value in
  let will_retry =
    job.retry_count < job.max_retries
    &&
    match failure_class with
    | Some (Enums.Failure_class.Deterministic | Enums.Failure_class.Withheld) ->
        false
    | _ -> true
  in
  let fields =
    List.filter_map Fun.id
      [
        Some ("error", text error);
        Some ("willRetry", `Bool will_retry);
        optional "failureClass"
          (Option.map
             (fun value -> text (Enums.Failure_class.to_string value))
             failure_class);
        optional "completedUnits" completed;
        optional "unitCursors" cursors;
      ]
  in
  settle job (fun () -> lifecycle job B.Channels.job_fail fields)
