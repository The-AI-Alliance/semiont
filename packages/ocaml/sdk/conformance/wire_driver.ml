open Eio.Std
module B = Semiont.Bus_registry
module S = Semiont.Subscription
module Session = Semiont.Session
module J = Yojson.Safe.Util
module H = Semiont.Http_wire

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

let resource value =
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
  let fields = [ ("code", text code) ] in
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
}

let run env =
  Switch.run @@ fun sw ->
  let output = Eio.Stdenv.stdout env in
  let input = Eio.Buf_read.of_flow ~max_size:1_048_576 (Eio.Stdenv.stdin env) in
  let lock = Eio.Mutex.create () in
  let output_json value =
    Eio.Mutex.use_rw ~protect:true lock (fun () -> write output value)
  in
  let client = ref None in
  let listens = Hashtbl.create 8 in
  let holds = Hashtbl.create 8 in
  let active = Hashtbl.create 8 in
  let get_client () =
    match !client with
    | Some value -> value
    | None -> raise (Misuse "open first")
  in
  let on_event = function
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
  let open_client input =
    if Option.is_some !client then raise (Misuse "one client per driver");
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
        ~renew:(fun ~refused:_ ->
          match !renewals with
          | [] -> Session.Refused
          | bearer :: rest ->
              renewals := rest;
              Session.Renewed bearer)
        ()
    in
    let http =
      H.make ~clock ~session ~timing:http_timing
        ~key:(fun () -> uuid env)
        ~on_error:(fun failure ->
          output_json
            (`Assoc [ ("error", error ?status:failure.status failure.code) ]))
        ~call ()
    in
    let connect =
      S.authenticated
        ~credential:(fun () -> Session.credential session)
        ~renew:(Session.refresh_refused session)
        ~on_refused:(fun status ->
          output_json (`Assoc [ ("error", error ~status "unauthorized") ]))
        (H.subscribe http)
    in
    let client_id = uuid env in
    let global =
      field "channels" input |> J.to_list
      |> List.map (fun name -> channel (J.to_string name))
    in
    let subscription =
      S.start ~timing:subscription_timing ~sw ~clock ~client_id ~global
        ~scopes:[] ~connect ~on_event ()
    in
    client := Some { subscription; session; client_id; http };
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
  let close () =
    Option.iter
      (fun client ->
        S.close client.subscription;
        Session.close client.session;
        S.await_closed client.subscription;
        Session.await_closed client.session)
      !client
  in
  let perform input =
    let ok value = ("ok", value) in
    let done_ = ok `Null in
    match string "op" input with
    | "open" ->
        open_client input;
        done_
    | "close" ->
        close ();
        done_
    | "sync" -> done_
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
            { resource = resource name; channels }
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
                  (fun value -> resource (J.to_string value))
                  "scope" input)
             ?correlation_id:(optional J.to_string "correlationId" input)
             channel (field "payload" input))
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
            ok (Yojson.Safe.from_string (B.encode payload))
        | Ok (S.Failure payload) -> ("error", error (H.bus_failure payload))
        | Error S.Timeout -> ("error", error "bus.timeout")
        | Error S.Transport_closed -> ("error", error "bus.closed")
        | Error S.Unsubscribed -> ("error", error "bus.unsubscribed")
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
                (resource (string "resource" input))))
    | "graph" ->
        ok
          (Yojson.Safe.from_string
             (H.graph (get_client ()).http (resource (string "resource" input))))
    | "annotations" ->
        ok
          (Yojson.Safe.from_string
             (H.annotations (get_client ()).http
                (resource (string "resource" input))))
    | "anchored-text" ->
        ok
          (Yojson.Safe.from_string
             (H.anchored_text (get_client ()).http
                (resource (string "resource" input))))
    | "get" | "get-stream" ->
        H.with_content (get_client ()).http
          (resource (string "resource" input))
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

let () = Eio_main.run run
