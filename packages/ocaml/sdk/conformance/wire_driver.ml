open Eio.Std
module B = Semiont.Bus_registry
module S = Semiont.Subscription
module Session = Semiont.Session
module J = Yojson.Safe.Util
module H = Semiont.Http_wire
module L = Semiont.Live_query
module D = Semiont.Delegation
module W = Semiont.Worker

exception Misuse of string

let text value = `String value

let field name input =
  match input with `Null -> `Null | _ -> J.member name input

let string name input = J.to_string (field name input)
let optional read name input = J.to_option read (field name input)

let write stdout value =
  Eio.Flow.copy_string (Yojson.Safe.to_string value ^ "\n") stdout

let channel name =
  match List.find_opt (fun (B.Channel ch) -> B.name ch = name) B.channels with
  | Some channel -> channel
  | None -> raise (Misuse ("unknown channel " ^ name))

let operation name =
  match
    List.find_opt
      (fun (B.Operation op) -> B.name (B.request op) = name)
      B.operations
  with
  | Some operation -> operation
  | None -> raise (Misuse ("unknown operation " ^ name))

let resource_of_name value =
  match Semiont.Identifiers.Resource_id.of_string value with
  | Ok value -> value
  | Error _ -> raise (Misuse "invalid resource ID")

let state = function
  | S.Initial -> "initial"
  | S.Connecting -> "connecting"
  | S.Open -> "open"
  | S.Reconnecting -> "reconnecting"
  | S.Degraded -> "degraded"
  | S.Unauthenticated -> "unauthenticated"
  | S.Closed -> "closed"

let error ?status code =
  let fields = [ ("code", text code); ("detail", text code) ] in
  `Assoc
    (match status with
    | None -> fields
    | Some status -> ("status", `Int status) :: fields)

let uuid env =
  let bytes = Cstruct.create 16 in
  Eio.Flow.read_exact (Eio.Stdenv.secure_random env) bytes;
  Cstruct.set_uint8 bytes 6 (Cstruct.get_uint8 bytes 6 land 15 lor 64);
  Cstruct.set_uint8 bytes 8 (Cstruct.get_uint8 bytes 8 land 63 lor 128);
  let hex first last =
    List.init (last - first) (fun offset ->
        Printf.sprintf "%02x" (Cstruct.get_uint8 bytes (first + offset)))
    |> String.concat ""
  in
  String.concat "-" [ hex 0 4; hex 4 6; hex 6 8; hex 8 10; hex 10 16 ]

let body_text body = Eio.Buf_read.(take_all (of_flow ~max_size:1_048_576 body))

type client = {
  subscription : S.t;
  session : Session.t;
  client_id : string;
  http : H.t;
  clock : Semiont.Clock.t;
}

type mode = Wire | Worker | Live

let query_key value =
  let name = string "query" value in
  let resource = optional J.to_string "resource" value in
  let argument =
    if name = "resources" || name = "matchedResources" then
      let page = [ ("limit", `Int 100); ("offset", `Int 0) ] in
      let fields =
        if name = "matchedResources" then
          ("search", field "search" value) :: page
        else page
      in
      Some (Yojson.Safe.to_string (`Assoc fields))
    else optional J.to_string "annotation" value
  in
  (name, resource, argument)

let run mode env =
  Switch.run @@ fun sw ->
  let output = Eio.Stdenv.stdout env in
  let input = Eio.Buf_read.of_flow ~max_size:1_048_576 (Eio.Stdenv.stdin env) in
  let lock = Eio.Mutex.create () in
  let output_json value =
    Eio.Mutex.use_rw ~protect:true lock (fun () -> write output value)
  in
  let telemetry, flush_telemetry =
    match Sys.getenv_opt "OTEL_EXPORTER_OTLP_ENDPOINT" with
    | None -> (None, fun () -> ())
    | Some endpoint ->
        let http = Cohttp_eio.Client.make ~https:None (Eio.Stdenv.net env) in
        let post path payload =
          Switch.run @@ fun sw ->
          let uri = Uri.with_path (Uri.of_string endpoint) path in
          let headers =
            Cohttp.Header.init_with "content-type" "application/json"
          in
          let _, body =
            Cohttp_eio.Client.post http ~sw ~headers
              ~body:(Cohttp_eio.Body.of_string payload)
              uri
          in
          ignore (body_text body)
        in
        let sink, flush =
          Otlp.make
            ~id:(fun () ->
              String.concat "" (String.split_on_char '-' (uuid env)))
            ~post
        in
        (Some sink, flush)
  in
  let client = ref None in
  let persisted = Hashtbl.create 8 in
  let persist = ref false in
  let live = ref None in
  let observers = Hashtbl.create 8 in
  let held = ref None in
  let worker_facade = ref None in
  let claims = ref None in
  let stopping = ref false in
  let claim_timeout = ref None in
  let stall_ms = ref None and stall_check_ms = ref None in
  let listens = Hashtbl.create 8 in
  let holds = Hashtbl.create 8 in
  let commit_timeout = ref None in
  let delegation = ref None in
  let delegates = Hashtbl.create 4 in
  let active = Hashtbl.create 8 in
  let get_client () =
    match !client with
    | Some value -> value
    | None -> raise (Misuse "open first")
  in
  let report_frame = function
    | Ok (Semiont.Wire_stream.Frame { route; payload = Ok payload; _ })
      when Hashtbl.mem listens route.channel ->
        let fields =
          [
            Some ("channel", text route.channel);
            Some ("payload", Yojson.Safe.from_string (B.encode payload));
            Option.map
              (fun value -> ("correlationId", text value))
              route.correlation_id;
            Option.map
              (fun value ->
                ("scope", text (Semiont.Identifiers.Resource_id.to_string value)))
              route.scope;
          ]
          |> List.filter_map Fun.id
        in
        output_json (`Assoc [ ("frame", `Assoc fields) ])
    | _ -> ()
  in
  let on_event = report_frame in
  let open_client input =
    if Option.is_some !client then
      raise (Misuse "close the client before reopening");
    stopping := false;
    persist := field "persist" input = `Bool true;
    let base = Uri.of_string (string "baseUrl" input) in
    if Uri.scheme base <> Some "http" then
      raise (Misuse "the wire driver expects the harness HTTP proxy");
    let net = Eio.Stdenv.net env in
    let http = Cohttp_eio.Client.make ~https:None net in
    let call ~sw ~meth ~path ~headers ~body ~progress =
      let headers = Cohttp.Header.of_list headers in
      let body =
        match progress with
        | None -> Cohttp_eio.Body.of_string body
        | Some report ->
            let module Source = struct
              type t = int ref

              let read_methods = []

              let single_read offset buffer =
                let count =
                  min (Cstruct.length buffer) (String.length body - !offset)
                in
                if count = 0 then raise End_of_file;
                Cstruct.blit_from_string body !offset buffer 0 count;
                offset := !offset + count;
                report !offset;
                count
            end in
            Eio.Resource.T (ref 0, Eio.Flow.Pi.source (module Source))
      in
      let response, body =
        try
          Cohttp_eio.Client.call http ~sw ~headers ~body
            (Cohttp.Code.method_of_string meth)
            (Uri.with_path base path)
        with Failure message when message = "connection closed by peer" ->
          raise End_of_file
      in
      ( Cohttp.Code.code_of_status (Cohttp.Response.status response),
        Cohttp.Header.to_list (Cohttp.Response.headers response),
        (body :> Eio.Flow.source_ty Eio.Resource.t) )
    in
    let timing = field "timing" input in
    let value settings name default =
      Option.value (optional J.to_int name settings) ~default
    in
    let time name default = value timing name default in
    let s = S.default_timing in
    let subscription_timing : S.timing =
      {
        stream_open_timeout_ms =
          time "streamOpenTimeoutMs" s.stream_open_timeout_ms;
        reconnect_ms = time "reconnectMs" s.reconnect_ms;
        max_reconnect_ms = time "maxReconnectMs" s.max_reconnect_ms;
        degraded_threshold_ms =
          time "degradedThresholdMs" s.degraded_threshold_ms;
        reconnect_debounce_ms =
          time "reconnectDebounceMs" s.reconnect_debounce_ms;
        lazy_remove_ms = time "lazyRemoveMs" s.lazy_remove_ms;
        linger_ms = time "lingerMs" s.linger_ms;
        bus_request_timeout_ms =
          time "busRequestTimeoutMs" s.bus_request_timeout_ms;
      }
    in
    let h = H.default_timing in
    let retry = field "emitRetry" timing in
    let http_timing : H.timing =
      {
        emit_attempts = value retry "attempts" h.emit_attempts;
        emit_initial_delay_ms =
          value retry "initialDelayMs" h.emit_initial_delay_ms;
        emit_max_delay_ms = value retry "maxDelayMs" h.emit_max_delay_ms;
        emit_timeout_ms = time "emitTimeoutMs" h.emit_timeout_ms;
        request_timeout_ms = time "httpRequestTimeoutMs" h.request_timeout_ms;
      }
    in
    let renewals =
      ref
        (Option.value
           (optional
              (fun value -> J.to_list value |> List.map J.to_string)
              "renewals" input)
           ~default:[])
    in
    let clock =
      Semiont.Clock.make
        ~monotonic:(Eio.Stdenv.mono_clock env)
        ~wall:(Eio.Stdenv.clock env)
        ~jitter:(Random.State.make_self_init ())
    in
    let session =
      Session.start ~sw ~clock
        ~initial_token:(optional J.to_string "token" input)
        ~renew:(fun ~holding:_ ->
          match !renewals with
          | [] -> Session.Refused
          | bearer :: rest ->
              renewals := rest;
              Session.Renewed bearer)
        ()
    in
    let on_error (failure : H.failure) =
      output_json
        (`Assoc [ ("error", error ?status:failure.status failure.code) ])
    in
    let client_id = uuid env in
    let global =
      match mode with
      | Worker ->
          commit_timeout := optional J.to_int "markCommitTimeoutMs" timing;
          if field "commits" input = `Bool true then
            W.channels @ W.commit_channels
          else W.channels
      | Live ->
          [
            B.Channel B.Channels.mark_delete_ok;
            B.Channel B.Channels.mark_delete_failed;
          ]
      | Wire ->
          field "channels" input |> J.to_list
          |> List.map (fun value -> channel (J.to_string value))
    in
    claim_timeout := optional J.to_int "jobClaimTimeoutMs" timing;
    let key () = uuid env in
    let http, subscription =
      match mode with
      | Worker | Live ->
          let restore key =
            if !persist then Hashtbl.find_opt persisted key else None
          in
          let save key = function
            | Some value when !persist -> Hashtbl.replace persisted key value
            | None when !persist -> Hashtbl.remove persisted key
            | _ -> ()
          in
          let facade =
            Semiont.Client.connect ~subscribe_defaults:(mode = Live)
              ~timing:subscription_timing ~http_timing ?telemetry ~restore ~save
              ?invalidation_window_ms:
                (optional J.to_int "invalidationWindowMs" timing)
              ?delegation_silence_ms:(optional J.to_int "jobSilenceMs" timing)
              ?delegation_poll_ms:(optional J.to_int "jobStatusPollMs" timing)
              ~sw ~clock ~session ~client_id ~key ~call ~global ~on_event
              ~on_error ()
          in
          if mode = Worker then worker_facade := Some facade
          else (
            live := Some facade;
            delegation := Some (Semiont.Client.delegation facade));
          (Semiont.Client.http facade, Semiont.Client.subscription facade)
      | Wire ->
          let http =
            H.make ?telemetry ~clock ~session ~timing:http_timing ~key ~on_error
              ~call ()
          in
          let connect =
            S.authenticated
              ~credential:(fun () -> Session.credential session)
              ~renew:(Session.refresh_refused session)
              ~on_refused:(fun status ->
                on_error { code = "unauthorized"; status = Some status })
              (H.subscribe http)
          in
          let subscription =
            S.start ?telemetry ~timing:subscription_timing ~sw ~clock ~client_id
              ~global ~scopes:[] ~connect ~on_event ()
          in
          (http, subscription)
    in
    client := Some { subscription; session; client_id; http; clock };
    stall_ms := Some (time "heldJobStallMs" W.default_stall_ms);
    stall_check_ms := Some (time "heldJobStallCheckMs" W.default_stall_check_ms);
    Fiber.fork_daemon ~sw (fun () ->
        let rec report previous =
          let current = S.await_state_change subscription ~from:previous in
          output_json (`Assoc [ ("state", text (state current)) ]);
          if current <> S.Closed then report current
        in
        report S.Initial;
        `Stop_daemon)
  in
  let emit client ?scope ?correlation_id channel payload =
    H.emit client.http ~client_id:client.client_id ?scope ?correlation_id
      channel
      (Yojson.Safe.to_string payload)
    |> Yojson.Safe.from_string
  in
  let facade () =
    match !live with
    | Some facade -> facade
    | None -> raise (Misuse "open first")
  in
  let decode channel source =
    match B.decode channel source with
    | Ok value -> value
    | Error _ -> raise (Misuse "invalid namespace request")
  in
  let live_query value =
    let client = facade () in
    let module Browse = Semiont.Client.Browse in
    let name, resource, argument = query_key value in
    let resource () = resource_of_name (Option.get resource) in
    match name with
    | "resource" -> Browse.resource client (resource ())
    | "annotations" -> Browse.annotations client (resource ())
    | "annotation" ->
        let annotation =
          Result.get_ok
            (Semiont.Identifiers.Annotation_id.of_string (Option.get argument))
        in
        Browse.annotation client (resource ()) annotation
    | "events" -> Browse.events client (resource ())
    | "referencedBy" -> Semiont.Client.Gather.referenced_by client (resource ())
    | "entityTypes" -> Browse.entity_types client
    | "tagSchemas" -> Browse.tag_schemas client
    | "engines" -> Browse.engines client
    | "resources" ->
        Browse.resources client
          (decode B.Channels.browse_resources_requested (Option.get argument))
    | "matchedResources" ->
        Semiont.Client.Match.resources client
          (decode B.Channels.match_resources_requested (Option.get argument))
    | _ -> raise (Misuse "unknown live query")
  in
  let state_json = function
    | L.Pending -> `Assoc [ ("status", text "pending") ]
    | L.Ready value -> `Assoc [ ("status", text "ready"); ("value", value) ]
    | L.Failed code ->
        `Assoc [ ("status", text "failed"); ("error", error code) ]
  in
  let delegate ~verb input =
    let follower = Option.get !delegation in
    let observer = string "observer" input in
    if Hashtbl.mem observers observer then raise (Misuse "duplicate observer");
    let output state =
      output_json
        (`Assoc
           [
             ( "emission",
               `Assoc [ ("observer", text observer); ("state", state) ] );
           ])
    in
    let on_report kind data =
      let kind =
        match kind with
        | D.Created -> "created"
        | D.Progress -> "progress"
        | D.Complete -> "complete"
        | D.Retrying -> "failed"
        | D.Refused -> "refused"
      in
      output
        (state_json (L.Ready (`Assoc [ ("kind", text kind); ("data", data) ])))
    in
    let on_failure (failure : D.failure) =
      let details =
        Option.to_list
          (Option.map
             (fun value ->
               ( "failureClass",
                 text (Semiont.Enums.Failure_class.to_string value) ))
             failure.failure_class)
      in
      output
        (`Assoc
           [
             ("status", text "failed");
             ( "error",
               `Assoc
                 ([ ("code", text failure.code); ("detail", text failure.code) ]
                 @ details) );
           ])
    in
    let on_close () =
      Hashtbl.remove delegates observer;
      Hashtbl.remove observers observer;
      output_json (`Assoc [ ("completed", text observer) ])
    in
    let params descriptor =
      match
        Semiont.Models.decode descriptor
          (Yojson.Safe.to_string (field "params" input))
      with
      | Ok value -> value
      | Error _ -> raise (Misuse "invalid delegation parameters")
    in
    let release =
      if verb = "mark" then
        Semiont.Mark.delegate follower
          ~resource:(resource_of_name (string "resource" input))
          ~params:(params Semiont.Models.mark_job_params)
          ~on_report ~on_failure ~on_close ()
      else
        Semiont.Yield.delegate follower
          ?stall_ms:(optional J.to_int "stallDeadlineMs" input)
          ~params:(params Semiont.Models.generation_job_request)
          ~on_report ~on_failure ~on_close ()
    in
    Hashtbl.replace delegates observer release;
    Hashtbl.replace observers observer release
  in
  let start_claims accepts =
    if Option.is_some !claims then raise (Misuse "claims already started");
    let filters =
      J.to_list accepts
      |> List.map (fun value ->
          match
            Semiont.Models.decode Semiont.Models.job_filter
              (Yojson.Safe.to_string value)
          with
          | Ok filter -> filter
          | Error _ -> raise (Misuse "invalid claim filter"))
    in
    let trace () =
      Option.map
        (fun _ ->
          let hex () = String.concat "" (String.split_on_char '-' (uuid env)) in
          {
            Semiont.Wire_stream.parent =
              "00-" ^ hex () ^ "-" ^ String.sub (hex ()) 0 16 ^ "-01";
            state = None;
          })
        telemetry
    in
    let on_refused code =
      let fields =
        ("detail", text (Option.value code ~default:"invalid claim reply"))
        :: Option.to_list (Option.map (fun code -> ("code", text code)) code)
      in
      output_json (`Assoc [ ("refused", `Assoc fields) ])
    in
    let on_cancel job =
      output_json (`Assoc [ ("signalled", text (W.id job)) ])
    in
    let on_stalled job =
      output_json (`Assoc [ ("stalled", text (W.id job)) ])
    in
    let stream =
      Semiont.Client.Job.claim
        (Option.get !worker_facade)
        ?timeout_ms:!claim_timeout ?stall_ms:!stall_ms
        ?stall_check_ms:!stall_check_ms ~trace ~on_refused ~on_cancel
        ~on_stalled filters
    in
    claims := Some stream;
    Fiber.fork ~sw (fun () ->
        let rec consume () =
          match Semiont.Claims.next stream with
          | Some job when not !stopping ->
              held := Some job;
              let view =
                `Assoc
                  [
                    ( "jobId",
                      text (Semiont.Identifiers.Job_id.to_string (W.job_id job))
                    );
                    ( "jobType",
                      text (Semiont.Enums.Job_type.to_string (W.job_type job))
                    );
                    ( "resourceId",
                      text
                        (Semiont.Identifiers.Resource_id.to_string
                           (W.resource_id job)) );
                    ("params", W.params job);
                    ( "completedUnits",
                      `List (List.map text (W.completed_units job)) );
                    ("unitCursors", W.unit_cursors job);
                    ("retryCount", `Int (W.retry_count job));
                    ("maxRetries", `Int (W.max_retries job));
                  ]
              in
              output_json (`Assoc [ ("claimed", view) ]);
              consume ()
          | _ -> ()
        in
        consume ())
  in
  let job () =
    match !held with Some job -> job | None -> raise (Misuse "no held job")
  in
  let settle action =
    let job = job () in
    Semiont.Telemetry.around ?trace:(W.trace job) telemetry
      ~clock:(get_client ()).clock
      ("worker.run", Semiont.Telemetry.Consumer)
      [ ("job.id", Semiont.Telemetry.String (W.id job)) ]
      (fun () -> action job);
    held := None
  in
  let close ?(settle_worker = false) () =
    stopping := true;
    Option.iter Semiont.Client.close !live;
    live := None;
    Hashtbl.to_seq_keys delegates
    |> List.of_seq
    |> List.iter (fun key ->
        Option.iter (fun finish -> finish ()) (Hashtbl.find_opt observers key));
    Hashtbl.clear observers;
    Option.iter (Semiont.Claims.stop ~settle:settle_worker) !claims;
    claims := None;
    Option.iter Semiont.Client.close !worker_facade;
    worker_facade := None;
    held := None;
    Option.iter
      (fun client ->
        S.close client.subscription;
        Session.close client.session;
        S.await_closed client.subscription;
        Session.await_closed client.session)
      !client;
    client := None;
    delegation := None;
    flush_telemetry ()
  in
  let perform input =
    let ok value = ("ok", value) in
    let done_ = ok `Null in
    match string "op" input with
    | "open" ->
        open_client input;
        done_
    | "close" ->
        close ~settle_worker:true ();
        done_
    | "sync" -> done_
    | "claim" when mode = Worker ->
        start_claims (field "accepts" input);
        done_
    | "vitals" when mode = Worker ->
        let vitals = Option.map Semiont.Claims.vitals !claims in
        let value get encode =
          Option.fold ~none:`Null ~some:encode (Option.bind vitals get)
        in
        let stamp get = value get (fun time -> `Float time) in
        let active_job =
          value
            (fun v -> v.Semiont.Claims.active_job)
            (fun (job, since) ->
              `Assoc
                [
                  ("jobId", text (W.id job));
                  ( "type",
                    text (Semiont.Enums.Job_type.to_string (W.job_type job)) );
                  ("since", `Float since);
                ])
        in
        ok
          (`Assoc
             [
               ("lastQueuedEventAt", stamp (fun v -> v.last_queued_event_at));
               ("lastClaimAt", stamp (fun v -> v.last_claim_at));
               ("lastFinishedAt", stamp (fun v -> v.last_finished_at));
               ("lastActivityAt", stamp (fun v -> v.last_activity_at));
               ("activeJob", active_job);
               ( "jobsCompleted",
                 `Int
                   (Option.fold ~none:0
                      ~some:(fun v -> v.Semiont.Claims.jobs_completed)
                      vitals) );
             ])
    | "start" when mode = Worker ->
        W.start (job ());
        done_
    | "progress" when mode = Worker ->
        W.progress (job ())
          ~percentage:(J.to_int (field "percentage" input))
          ~message:(optional Fun.id "message" input);
        done_
    | "checkpoint" when mode = Worker ->
        W.checkpoint (job ())
          ~completed:(field "completedUnits" input)
          ~cursors:(field "unitCursors" input);
        done_
    | "commit" when mode = Worker -> (
        let client = get_client () in
        match
          W.commit (job ()) client.subscription
            ~correlation_id:(fun () -> uuid env)
            ?timeout_ms:!commit_timeout
            ~resource:(resource_of_name (string "resourceId" input))
            ~annotations:(J.to_list (field "annotations" input))
            ()
        with
        | Ok () -> done_
        | Error code -> ("error", error code))
    | "complete" when mode = Worker ->
        settle (fun job -> W.complete job (field "result" input));
        done_
    | "cancel" when mode = Worker ->
        settle (fun job ->
            W.cancel job ~completed:(optional Fun.id "completedUnits" input));
        done_
    | "fail" when mode = Worker ->
        let failure_class =
          Option.bind
            (optional J.to_string "failureClass" input)
            Semiont.Enums.Failure_class.of_string
        in
        settle (fun job ->
            W.fail job ~error:(string "error" input) ~failure_class
              ~completed:(optional Fun.id "completedUnits" input)
              ~cursors:(optional Fun.id "unitCursors" input));
        done_
    | "delete" when mode = Live -> (
        let payload =
          `Assoc
            [
              ("resourceId", field "resource" input);
              ("annotationId", field "annotation" input);
            ]
          |> Yojson.Safe.to_string
          |> decode B.Channels.mark_delete
        in
        match Semiont.Client.Mark.delete (facade ()) payload with
        | Ok _ -> done_
        | Error (Semiont.Client.Refused code) -> ("error", error code)
        | Error (Semiont.Client.Http failure) ->
            ("error", error ?status:failure.status failure.code)
        | Error (Semiont.Client.Transport _) -> ("error", error "bus.closed"))
    | "markDelegate" when mode = Live ->
        delegate ~verb:"mark" input;
        done_
    | "yieldDelegate" when mode = Live ->
        delegate ~verb:"yield" input;
        done_
    | "observe" when mode = Live && !stopping ->
        output_json (`Assoc [ ("completed", field "observer" input) ]);
        done_
    | "observe" when mode = Live ->
        let observer = string "observer" input in
        if Hashtbl.mem observers observer then
          raise (Misuse "duplicate observer");
        let release =
          Semiont.Client.observe
            (live_query (field "query" input))
            ~on_state:(fun state ->
              output_json
                (`Assoc
                   [
                     ( "emission",
                       `Assoc
                         [
                           ("observer", text observer);
                           ("state", state_json state);
                         ] );
                   ]))
            ~on_close:(fun () ->
              output_json (`Assoc [ ("completed", text observer) ]))
        in
        Hashtbl.add observers observer release;
        done_
    | "unobserve" when mode = Live ->
        let observer = string "observer" input in
        Option.iter
          (fun release -> release ())
          (Hashtbl.find_opt observers observer);
        Hashtbl.remove observers observer;
        done_
    | "fresh" when mode = Live && !stopping -> ("error", error "bus.closed")
    | "fresh" when mode = Live -> (
        match Semiont.Client.fresh (live_query (field "query" input)) with
        | Ok value -> ok (`Assoc [ ("value", value) ])
        | Error code -> ("error", error code))
    | "invalidate" when mode = Live ->
        Semiont.Client.invalidate (live_query (field "query" input));
        done_
    | "listen" ->
        Hashtbl.replace listens (string "channel" input) ();
        done_
    | "set-token" ->
        Session.replace (get_client ()).session
          (optional J.to_string "token" input);
        done_
    | "subscribe-resource" ->
        let name = string "resource" input in
        let channels =
          List.filter
            (fun (B.Channel ch) -> B.audience ch = Some B.Scoped)
            B.channels
        in
        let release =
          S.hold_scope (get_client ()).subscription
            { resource = resource_of_name name; channels }
        in
        Hashtbl.replace holds name
          (release :: Option.value (Hashtbl.find_opt holds name) ~default:[]);
        done_
    | "release-resource" ->
        let name = string "resource" input in
        (match Hashtbl.find_opt holds name with
        | Some (release :: rest) ->
            release ();
            Hashtbl.replace holds name rest
        | _ -> ());
        done_
    | "emit" ->
        let (B.Channel channel) = channel (string "channel" input) in
        ok
          (emit (get_client ())
             ?scope:
               (optional
                  (fun value -> resource_of_name (J.to_string value))
                  "scope" input)
             ?correlation_id:(optional J.to_string "correlationId" input)
             channel (field "payload" input))
    | "request" when !stopping -> ("error", error "bus.closed")
    | "request" -> (
        let (B.Operation operation) = operation (string "operation" input) in
        let client = get_client () in
        let correlation_id = uuid env in
        let send () =
          ignore
            (emit client ~correlation_id (B.request operation)
               (field "payload" input))
        in
        match
          S.request client.subscription
            ?timeout_ms:(optional J.to_int "timeoutMs" input)
            ~correlation_id operation ~send
        with
        | Ok (S.Result payload) ->
            let fields =
              Yojson.Safe.from_string (B.encode payload) |> J.to_assoc
            in
            ok
              (`Assoc (List.filter (fun (name, _) -> name = "response") fields))
        | Ok (S.Failure payload) -> ("error", error (H.bus_failure payload))
        | Error S.Timeout -> ("error", error "bus.timeout")
        | Error S.Transport_closed -> ("error", error "bus.closed")
        | Error S.Unsubscribed -> ("error", error "bus.unsubscribed")
        | Error S.Unrecognized_failure -> ("error", error "bus.rejected")
        | Error _ -> ("error", error "error"))
    | "health" -> ok (Yojson.Safe.from_string (H.health (get_client ()).http))
    | "status" -> ok (Yojson.Safe.from_string (H.status (get_client ()).http))
    | "current-user" ->
        ok (Yojson.Safe.from_string (H.current_user (get_client ()).http))
    | "protected-resource-metadata" ->
        ok
          (Yojson.Safe.from_string
             (H.protected_resource_metadata (get_client ()).http))
    | "media-token" ->
        ok
          (Yojson.Safe.from_string
             (H.media_token (get_client ()).http
                (resource_of_name (string "resource" input))))
    | "graph" ->
        ok
          (Yojson.Safe.from_string
             (H.graph (get_client ()).http
                (resource_of_name (string "resource" input))))
    | "annotations" ->
        ok
          (Yojson.Safe.from_string
             (H.annotations (get_client ()).http
                (resource_of_name (string "resource" input))))
    | "anchored-text" ->
        ok
          (Yojson.Safe.from_string
             (H.anchored_text (get_client ()).http
                (resource_of_name (string "resource" input))))
    | ("get" | "get-stream") as op ->
        H.with_content (get_client ()).http ~streaming:(op = "get-stream")
          (resource_of_name (string "resource" input))
          (fun ~content_type stream ->
            ok
              (`Assoc
                 [
                   ("contentType", text content_type);
                   ("bytes", text (Base64.encode_exn (body_text stream)));
                 ]))
    | ("put" | "upload") as op ->
        let fields =
          J.to_assoc input
          |> List.filter_map (fun (name, value) ->
              match value with
              | `Null -> None
              | `String value -> Some (name, value)
              | value -> Some (name, Yojson.Safe.to_string value))
        in
        let bytes = Base64.decode_exn (string "bytes" input) in
        let on_progress count =
          if op = "upload" then
            output_json
              (`Assoc
                 [
                   ( "progress",
                     `Assoc
                       [
                         ("upload", field "id" input);
                         ("bytesUploaded", `Int count);
                         ("totalBytes", `Int (String.length bytes));
                       ] );
                 ])
        in
        ok
          (Yojson.Safe.from_string
             (H.put (get_client ()).http ~fields ~bytes ~on_progress))
    | "abandon" ->
        Option.iter
          (fun cancel -> Eio.Cancel.cancel cancel Exit)
          (Hashtbl.find_opt active (J.to_int (field "request" input)));
        done_
    | _ -> ("unsupported", `Bool true)
  in
  output_json (`Assoc [ ("ready", `Bool true) ]);
  let rec loop () =
    match Eio.Buf_read.line input with
    | exception End_of_file -> close ()
    | line ->
        let input = Yojson.Safe.from_string line in
        let id = J.to_int (field "id" input) in
        Fiber.fork ~sw (fun () ->
            let answer =
              try
                Eio.Cancel.sub (fun cancel ->
                    Hashtbl.add active id cancel;
                    Fun.protect
                      ~finally:(fun () -> Hashtbl.remove active id)
                      (fun () -> perform input))
              with
              | Eio.Cancel.Cancelled Exit -> ("abandoned", `Bool true)
              | Misuse message | J.Type_error (message, _) ->
                  ("misuse", text message)
              | H.Failed failure ->
                  ("error", error ?status:failure.status failure.code)
              | Eio.Io _ -> ("error", error "error")
            in
            output_json (`Assoc [ ("id", `Int id); answer ]));
        loop ()
  in
  loop ()

let () =
  let mode =
    match Array.to_list Sys.argv with
    | [ _; "--worker" ] -> Worker
    | [ _; "--live" ] -> Live
    | _ -> Wire
  in
  Eio_main.run (run mode)
