open Eio.Std

type timing = {
  emit_attempts : int;
  emit_initial_delay_ms : int;
  emit_max_delay_ms : int;
  emit_timeout_ms : int;
  request_timeout_ms : int;
}

let default_timing =
  let retry = Client_timing.emit_retry in
  {
    emit_attempts = retry.attempts;
    emit_initial_delay_ms = retry.initial_delay_ms;
    emit_max_delay_ms = retry.max_delay_ms;
    emit_timeout_ms = Client_timing.emit_timeout_ms;
    request_timeout_ms = Client_timing.http_request_timeout_ms;
  }

type failure = { code : string; status : int option; message : string }

exception Failed of failure
exception Deadline

type t = {
  timing : timing;
  telemetry : Telemetry.t option;
  clock : Clock.t;
  session : Session.t;
  key : unit -> string;
  on_error : failure -> unit;
  call :
    sw:Switch.t ->
    meth:string ->
    path:string ->
    headers:(string * string) list ->
    body:string ->
    progress:(int -> unit) option ->
    int * (string * string) list * Eio.Flow.source_ty Eio.Resource.t;
}

let make ?(timing = default_timing) ?telemetry ~clock ~session ~key ~on_error
    ~call () =
  { timing; telemetry; clock; session; key; on_error; call }

let fail t ?status ~message code =
  let failure = { code; status; message } in
  t.on_error failure;
  raise (Failed failure)

let json_text key source =
  match Strict_json.parse source with
  | Ok (`Assoc fields) -> (
      match List.assoc_opt key fields with
      | Some (`Stringlit literal) -> (
          match Yojson.Safe.from_string literal with
          | `String value -> Some value
          | _ -> None)
      | _ -> None)
  | _ -> None

(* A refusal in the gateway's own words when its body states them, as an
   ErrorResponse's error, and by its status when it does not. *)
let refusal status body =
  match json_text "error" body with
  | Some words -> words
  | None -> "HTTP " ^ string_of_int status

let unanswered = "The request got no answer before its deadline"
let unreachable = "The gateway could not be reached"
let body_text body = Eio.Buf_read.(take_all (of_flow ~max_size:16_777_216 body))

let header name =
  List.find_map (fun (key, value) ->
      if String.lowercase_ascii key = name then Some value else None)

let credential_refused status body =
  status = 401 || (status = 429 && json_text "code" body = Some "refusal-rate")

let bearer token headers =
  match token with
  | None -> headers
  | Some token -> ("authorization", "Bearer " ^ token) :: headers

let sleep t = Retry.sleep_ms t.clock

let retry_after headers =
  Option.bind (header "retry-after" headers) Retry.retry_after_ms
  |> Option.fold ~none:0. ~some:float

let subscribe t ~sw snapshot ~bearer:token =
  let meth, path = Http_facts.subscribe in
  let body = Result.get_ok (Subscription.encode_subscription snapshot) in
  let status, headers, stream =
    t.call ~sw ~meth ~path
      ~headers:(bearer (Some token) [ ("content-type", "application/json") ])
      ~body ~progress:None
  in
  if status = 200 then Ok (Eio.Buf_read.of_flow ~max_size:16_777_216 stream)
  else
    let detail = body_text stream in
    if credential_refused status detail then
      Error (Subscription.Credential_refused status)
    else (
      t.on_error
        {
          code = Http_facts.status_code status;
          status = Some status;
          message = refusal status detail;
        };
      Error
        (Subscription.Connect_retry_after (int_of_float (retry_after headers))))

let exchange t ~auth ?progress ?timeout_ms ?(headers = []) ?(body = "")
    ?(attempts = 1) ?(initial_delay = 0) ?(max_delay = 0) ?(jitter = false)
    (meth, path) read =
  let keyed = Option.is_some (header "idempotency-key" headers) in
  let initial = if auth then Session.credential t.session else None in
  let rec attempt token renewed left delay =
    let send () =
      Switch.run @@ fun sw ->
      let status, headers, stream =
        t.call ~sw ~meth ~path ~headers:(bearer token headers) ~body ~progress
      in
      if status >= 200 && status < 300 then Ok (read headers stream)
      else Error (status, headers, body_text stream)
    in
    let outcome =
      try
        `Answered
          (match timeout_ms with
          | None -> send ()
          | Some ms ->
              Fiber.first send (fun () ->
                  sleep t (float ms);
                  raise Deadline))
      with
      | Eio.Io _ -> `Lost
      | End_of_file -> `Lost
      | Deadline -> `Expired
    in
    let retry minimum =
      let pause =
        if jitter then float delay *. (0.5 +. (Clock.jitter t.clock *. 0.5))
        else float delay
      in
      sleep t (max minimum pause);
      attempt token renewed (left - 1) (min (delay * 2) max_delay)
    in
    match outcome with
    | `Answered (Ok value) -> value
    | `Expired when jitter && left > 1 -> retry 0.
    | `Expired -> fail t ~message:unanswered "unavailable"
    | `Lost when left > 1 -> retry 0.
    | `Lost -> fail t ~message:unreachable "unavailable"
    | `Answered (Error (status, headers, detail)) ->
        let message = refusal status detail in
        if credential_refused status detail then
          match token with
          | Some refused when not renewed -> (
              match Session.refresh_refused t.session ~refused with
              | Some replacement ->
                  attempt (Some replacement) true attempts initial_delay
              | None -> fail t ~status ~message "unauthorized")
          | _ -> fail t ~status ~message "unauthorized"
        else if
          left > 1
          && Retry.retryable
               (if jitter then Retry.Boot else Retry.Transport)
               ~status ~meth ~keyed ()
        then retry (retry_after headers)
        else fail t ~status ~message (Http_facts.status_code status)
  in
  attempt initial false attempts initial_delay

let read_text _ stream = body_text stream

let around t row attributes run =
  Telemetry.around t.telemetry ~clock:t.clock row attributes run

let emit t ~client_id ?scope ?correlation_id ?trace channel source =
  let body =
    match
      Wire_stream.encode_emit ~client_id ?scope ?correlation_id channel source
    with
    | Ok body -> body
    | Error _ ->
        fail t ~message:"The emit's payload is not its channel's" "bad-request"
  in
  let open Telemetry_facts in
  let name = Bus_registry.name channel in
  if Bus_log.active () then
    Bus_log.write "EMIT" ~channel:name
      ?scope:(Option.map Identifiers.Resource_id.to_string scope)
      ?correlation_id
      ?trace:
        (Option.bind trace (fun (trace : Wire_stream.trace) ->
             Bus_log.trace_id trace.parent))
      (Yojson.Safe.from_string source);
  let attributes =
    (attr_bus_channel, Telemetry.String name)
    :: Option.to_list
         (Option.map
            (fun scope ->
              ( attr_bus_scope,
                Telemetry.String (Identifiers.Resource_id.to_string scope) ))
            scope)
  in
  let prefix, kind = bus_emit in
  Telemetry.around ?trace t.telemetry ~clock:t.clock
    (prefix ^ name, kind)
    attributes
    (fun () ->
      Option.iter
        (fun (sink : Telemetry.t) ->
          sink.increment
            {
              name = semiont_bus_sent;
              attributes;
              time = Clock.wall_now t.clock;
            })
        t.telemetry;
      let timing = t.timing in
      exchange t ~auth:true ~timeout_ms:timing.emit_timeout_ms ~body
        ~headers:
          ([
             ("content-type", "application/json"); ("idempotency-key", t.key ());
           ]
          @ Option.fold ~none:[]
              ~some:(fun (trace : Wire_stream.trace) ->
                ("traceparent", trace.parent)
                :: Option.to_list
                     (Option.map
                        (fun state -> ("tracestate", state))
                        trace.state))
              trace)
        ~attempts:timing.emit_attempts
        ~initial_delay:timing.emit_initial_delay_ms
        ~max_delay:timing.emit_max_delay_ms ~jitter:true Http_facts.emit
        read_text)

let bus_failure payload =
  Http_facts.bus_failure
    (Option.map Http_facts.Failure_code.of_wire
       (json_text "code" (Bus_registry.encode payload)))

let json_get t ?(auth = true) path =
  exchange t ~auth ~timeout_ms:t.timing.request_timeout_ms ~attempts:2
    ~initial_delay:Client_timing.request_retry_pause_ms path read_text

let health t = json_get t ~auth:false Http_facts.health
let status t = json_get t Http_facts.status
let current_user t = json_get t Http_facts.current_user

let check_user t token =
  try
    let meth, path = Http_facts.current_user in
    let check () =
      Switch.run (fun sw ->
          let status, _, stream =
            t.call ~sw ~meth ~path ~headers:(bearer (Some token) []) ~body:""
              ~progress:None
          in
          let body = body_text stream in
          if status >= 200 && status < 300 then Ok body
          else
            Error
              {
                code =
                  (if credential_refused status body then "unauthorized"
                   else "unavailable");
                status = Some status;
                message = refusal status body;
              })
    in
    Fiber.first check (fun () ->
        sleep t (float t.timing.request_timeout_ms);
        Error { code = "unavailable"; status = None; message = unanswered })
  with Eio.Io _ | End_of_file ->
    Error { code = "unavailable"; status = None; message = unreachable }

let protected_resource_metadata t =
  json_get t ~auth:false Http_facts.protected_resource_metadata

let on_resource (meth, path) resource =
  let id = Identifiers.Resource_id.to_string resource in
  let at = String.index path '{' in
  let last = String.index_from path at '}' in
  ( meth,
    String.sub path 0 at ^ id
    ^ String.sub path (last + 1) (String.length path - last - 1) )

let resource_attrs resource =
  [
    ( Telemetry_facts.attr_resource_id,
      Telemetry.String (Identifiers.Resource_id.to_string resource) );
  ]

let resource_json t row path resource =
  around t row (resource_attrs resource) (fun () ->
      json_get t (on_resource path resource))

let graph t = resource_json t Telemetry_facts.content_get_graph Http_facts.graph

let annotations t =
  resource_json t Telemetry_facts.content_get_annotations Http_facts.annotations

let anchored_text t =
  resource_json t Telemetry_facts.content_get_anchored_text
    Http_facts.anchored_text

let media_token t resource =
  let body =
    Yojson.Safe.to_string
      (`Assoc
         [
           ("resourceId", `String (Identifiers.Resource_id.to_string resource));
         ])
  in
  exchange t ~auth:true ~timeout_ms:t.timing.request_timeout_ms ~body
    ~headers:[ ("content-type", "application/json") ]
    Http_facts.media_token read_text

let with_content t ?(streaming = true) resource consume =
  Bus_log.write "GET" ~channel:"content"
    ~scope:(Identifiers.Resource_id.to_string resource)
    (`Assoc []);
  let attrs = resource_attrs resource in
  let attrs =
    if streaming then
      (Telemetry_facts.attr_content_stream, Telemetry.Bool true) :: attrs
    else attrs
  in
  around t Telemetry_facts.content_get attrs (fun () ->
      exchange t ~auth:true ~timeout_ms:t.timing.request_timeout_ms ~attempts:2
        ~initial_delay:Client_timing.request_retry_pause_ms
        (on_resource Http_facts.representation resource) (fun headers stream ->
          let content_type =
            Option.value
              (header "content-type" headers)
              ~default:"application/octet-stream"
          in
          consume ~content_type stream))

let put t ~fields ~bytes ~on_progress =
  if Bus_log.active () then
    Bus_log.write "PUT" ~channel:"content"
      (`Assoc (List.map (fun (key, value) -> (key, `String value)) fields));
  let attrs =
    [
      ( Telemetry_facts.attr_content_format,
        Telemetry.String
          (Option.value (List.assoc_opt "format" fields) ~default:"") );
      ( Telemetry_facts.attr_content_size_bytes,
        Telemetry.Int (String.length bytes) );
    ]
  in
  around t Telemetry_facts.content_put attrs (fun () ->
      let key = t.key () in
      let boundary = t.key () in
      let buffer = Buffer.create (String.length bytes) in
      let part name value =
        Buffer.add_string buffer
          ("--" ^ boundary ^ "\r\nContent-Disposition: form-data; name=\""
         ^ name ^ "\"\r\n\r\n");
        Buffer.add_string buffer value;
        Buffer.add_string buffer "\r\n"
      in
      List.iter
        (fun name ->
          if name <> "file" then
            Option.iter (part name) (List.assoc_opt name fields))
        Http_facts.upload_fields;
      Buffer.add_string buffer
        ("--" ^ boundary
       ^ "\r\n\
          Content-Disposition: form-data; name=\"file\"; filename=\"upload\"\r\n\
          Content-Type: application/octet-stream\r\n\
          \r\n");
      let offset = Buffer.length buffer in
      Buffer.add_string buffer bytes;
      Buffer.add_string buffer ("\r\n--" ^ boundary ^ "--\r\n");
      let body = Buffer.contents buffer in
      let reported = ref (-1) in
      let report sent =
        let sent = min (String.length bytes) (max 0 (sent - offset)) in
        if sent > !reported then (
          reported := sent;
          on_progress sent)
      in
      exchange t ~auth:true ~body ~progress:report
        ~headers:
          [
            ("content-type", "multipart/form-data; boundary=" ^ boundary);
            ("idempotency-key", key);
          ]
        ~attempts:2 ~initial_delay:Client_timing.request_retry_pause_ms
        Http_facts.upload read_text)
