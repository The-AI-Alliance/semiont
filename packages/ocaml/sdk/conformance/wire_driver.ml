open Eio.Std
module B = Semiont.Bus_registry
module S = Semiont.Subscription
module Session = Semiont.Session
module J = Yojson.Safe.Util

exception Misuse of string
exception Http_error of int

let text value = `String value
let field name input = J.member name input
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
  post :
    sw:Switch.t ->
    bearer:string ->
    string ->
    string ->
    Cohttp.Response.t * Eio.Flow.source_ty Eio.Resource.t;
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
    let post ~sw ~bearer path body =
      let headers =
        Cohttp.Header.of_list
          [
            ("authorization", "Bearer " ^ bearer);
            ("content-type", "application/json");
          ]
      in
      let response, body =
        Cohttp_eio.Client.post http ~sw ~headers
          ~body:(Cohttp_eio.Body.of_string body)
          (Uri.with_path base path)
      in
      (response, (body :> Eio.Flow.source_ty Eio.Resource.t))
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
    let connect =
      S.authenticated
        ~credential:(fun () -> Session.credential session)
        ~renew:(Session.refresh_refused session)
        ~on_refused:(fun status ->
          output_json (`Assoc [ ("error", error ~status "unauthorized") ]))
        (fun ~sw snapshot ~bearer ->
          let body = Result.get_ok (S.encode_subscription snapshot) in
          let response, stream = post ~sw ~bearer Paths.subscribe body in
          match
            Cohttp.Code.code_of_status (Cohttp.Response.status response)
          with
          | 200 -> Ok (Eio.Buf_read.of_flow ~max_size:1_048_576 stream)
          | 401 -> Error (S.Credential_refused 401)
          | 429 ->
              let body = body_text stream |> Yojson.Safe.from_string in
              if field "code" body = text "refusal-rate" then
                Error (S.Credential_refused 429)
              else Error S.Connect_failed
          | _ -> Error S.Connect_failed)
    in
    let client_id = uuid env in
    let global =
      field "channels" input |> J.to_list
      |> List.map (fun name -> channel (J.to_string name))
    in
    let subscription =
      S.start ~sw ~clock ~client_id ~global ~scopes:[] ~connect ~on_event ()
    in
    client := Some { subscription; session; client_id; post };
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
    let bearer =
      match Session.credential client.session with
      | Some bearer -> bearer
      | None -> raise (Http_error 401)
    in
    let body =
      match
        Semiont.Wire_stream.encode_emit ?scope ?correlation_id
          ~client_id:client.client_id channel
          (Yojson.Safe.to_string payload)
      with
      | Ok body -> body
      | Error _ -> raise (Misuse "invalid emit payload")
    in
    Switch.run @@ fun sw ->
    let response, stream = client.post ~sw ~bearer Paths.emit body in
    let status = Cohttp.Code.code_of_status (Cohttp.Response.status response) in
    if status <> 202 then raise (Http_error status);
    let accepted =
      Result.get_ok
        (Semiont.Models.decode Semiont.Models.bus_emit_accepted
           (body_text stream))
    in
    Yojson.Safe.from_string (Semiont.Models.encode accepted)
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
        | Ok (S.Failure _) -> ("error", error "error")
        | Error S.Timeout -> ("error", error "timeout")
        | Error S.Transport_closed -> ("error", error "closed")
        | Error S.Unsubscribed -> ("error", error "unsubscribed")
        | Error _ -> ("error", error "error"))
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
              | Http_error status ->
                  ( "error",
                    error ~status
                      (if status = 401 then "unauthorized" else "error") )
              | Eio.Io _ -> ("error", error "error")
            in
            output_json (`Assoc [ ("id", `Int id); answer ]));
        loop ()
  in
  loop ()

let () = Eio_main.run run
