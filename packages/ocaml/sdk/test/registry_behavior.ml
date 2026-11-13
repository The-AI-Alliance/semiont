open Eio.Std
open Semiont
module R = Registry
module D = Discovery
module J = Yojson.Safe.Util

let field name = function
  | `Assoc fields -> Option.value (List.assoc_opt name fields) ~default:`Null
  | _ -> `Null

let string name value = J.to_string (field name value)
let int name value = J.to_int (field name value)
let rows name value = J.to_list (field name value)
let text value = `String value

let decode schema value =
  Result.get_ok (Models.decode schema (Yojson.Safe.to_string value))

(* Shared origin and ordering rows from session/registry-cases.json. *)
let shared () =
  let table = Yojson.Safe.from_string Registry_cases.cases in
  List.iter
    (fun row ->
      let read name = decode Models.kb_endpoint (field name row) in
      Alcotest.(check bool)
        (string "why" row)
        (J.to_bool (field "samePlace" row))
        (R.same_place (read "one") (read "other")))
    (rows "cases" table);
  List.iter
    (fun row ->
      let open_resource value : R.open_resource =
        let optional name =
          match field name value with `String text -> Some text | _ -> None
        in
        {
          id = string "id" value;
          name = string "name" value;
          opened_at = int "openedAt" value;
          order = int "order" value;
          media_type = optional "mediaType";
          storage_uri = optional "storageUri";
        }
      in
      let shown =
        R.sort_open_resources (List.map open_resource (rows "open" row))
      in
      Alcotest.(check (list string))
        (string "why" row)
        (List.map J.to_string (rows "shown" row))
        (List.map (fun (tab : R.open_resource) -> tab.id) shown))
    (rows "openResourceOrder" table)

(* Shared endpoint rows from session/gateway-url-cases.json. *)
let gateway_urls () =
  Yojson.Safe.from_string Registry_cases.gateway_cases
  |> J.to_list
  |> List.iter (fun row ->
      let endpoint = decode Models.http_endpoint (field "endpoint" row) in
      Alcotest.(check (option string))
        (string "why" row)
        (J.to_string_option (field "origin" row))
        (Host_name.gateway_url endpoint))

let discovery () =
  let parse = D.parse_discovery_document in
  assert (parse {|{"version":1,"kbs":[]}|} = D.Managed []);
  assert (parse {|{"version":2,"kbs":[]}|} = D.Absent D.Unsupported_version);
  assert (parse "html" = D.Absent D.Not_json);
  assert (parse {|{"version":1,"kbs":[{}]}|} = D.Absent D.Invalid);
  let entry port name =
    Printf.sprintf
      {|{"host":"localhost","port":%d,"did":"did:web:kb.example","managedBy":"semiont-launcher","placement":"local","siteName":"%s"}|}
      port name
  in
  let document entries =
    parse ("{\"version\":1,\"kbs\":[" ^ String.concat "," entries ^ "]}")
  in
  let a = entry 4010 "Local" and b = entry 4011 "Forward" in
  assert (D.discovery_diff (Some (document [ a; b ])) (document [ b; a ]) = None);
  let changed =
    Option.get
      (D.discovery_diff
         (Some (document [ a; b ]))
         (document [ entry 4010 "New"; a ]))
  in
  assert (List.length changed.updated = 2);
  assert (List.length changed.removed = 1);
  assert (changed.duplicated = [ ("localhost", 4010) ]);
  assert (D.text_discovery (fun () -> None) () = D.Read (D.Absent D.Not_found))

(* Discovery and deviceGrant rows from client/clock-cases.json. *)
let controlled () =
  let table = Yojson.Safe.from_string Registry_cases.clock_cases |> J.to_list in
  let timing = Yojson.Safe.from_string Registry_cases.timing in
  let number fallback = function
    | `Int n -> float n
    | `Float n -> n
    | _ -> fallback
  in
  let elapsed = function
    | `Int elapsed -> elapsed
    | value ->
        let base =
          match String.split_on_char '.' (string "timing" value) with
          | [ name ] -> int name timing
          | [ name; key ] -> int key (field name timing)
          | _ -> assert false
        in
        int_of_float
          ((float base *. number 1. (field "times" value))
          +. number 0. (field "plusMs" value))
  in
  List.iter
    (fun row ->
      Eio_mock.Backend.run @@ fun () ->
      Switch.run @@ fun sw ->
      let mono = Eio_mock.Clock.Mono.make () in
      let wall = Eio_mock.Clock.make () in
      let clock =
        Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
      in
      let count = ref 0 in
      let act = ref ignore in
      let cleanup = ref ignore in
      (match string "subject" row with
      | "discovery" ->
          let _release =
            D.subscribe_discovery ~sw ~clock
              (fun () ->
                incr count;
                if !count = 1 then D.Read (D.Managed []) else D.Unchanged)
              ~on_change:ignore
          in
          ()
      | "saveDebounce" ->
          let cache =
            State_units.Cache.make ~sw ~clock
              ~load:(fun _ -> assert false)
              ~save:(fun _ -> incr count)
              ()
          in
          (cleanup := fun () -> State_units.Cache.dispose cache);
          let changed = ref 0 in
          act :=
            fun () ->
              incr changed;
              State_units.Cache.set cache "key" (`Int !changed)
      | "renewal" ->
          let lifetime = int "lifetimeSeconds" (field "given" row) in
          let token () =
            let now = int_of_float (Clock.wall_now clock) in
            let claims =
              Yojson.Safe.to_string
                (`Assoc [ ("iat", `Int now); ("exp", `Int (now + lifetime)) ])
            in
            "header."
            ^ Base64.encode_exn ~pad:false ~alphabet:Base64.uri_safe_alphabet
                claims
            ^ ".signature"
          in
          ignore
            (Session.start ~sw ~clock
               ~initial_token:(Some (token ()))
               ~renew:(fun ~holding:_ ->
                 incr count;
                 Session.Renewed (token ()))
               ())
      | ( "refusedStream" | "unansweredStream" | "degradedStream" | "scopeTaken"
        | "scopeLetGo" | "handoffLinger" ) as subject -> (
          let clock = Clock.with_jitter clock (fun () -> 0.) in
          let session =
            Session.start ~sw ~clock ~initial_token:(Some "token")
              ~renew:(fun ~holding:_ -> Session.Refused)
              ()
          in
          let never, _ = Promise.create () in
          let module Source = struct
            type t = unit Promise.t

            let read_methods = []

            let single_read never _ =
              Promise.await never;
              0
          end in
          let source =
            Eio.Resource.T (never, Eio.Flow.Pi.source (module Source))
          in
          let call ~sw ~meth:_ ~path ~headers:_ ~body:_ ~progress:_ =
            assert (path = "/bus/subscribe");
            if subject = "handoffLinger" then
              Switch.on_release sw (fun () -> incr count)
            else if subject <> "degradedStream" then incr count;
            match subject with
            | "refusedStream" | "degradedStream" ->
                let headers =
                  match field "retryAfterSeconds" (field "given" row) with
                  | `Int seconds -> [ ("retry-after", string_of_int seconds) ]
                  | _ -> []
                in
                (503, headers, Eio.Flow.string_source "{}")
            | "unansweredStream" ->
                Promise.await never;
                assert false
            | _ -> (200, [], source)
          in
          let client =
            Client.connect ~sw ~clock ~session ~client_id:"clock-test"
              ~key:(fun () -> "clock-key")
              ~call ~global:[] ~on_event:ignore ()
          in
          (cleanup := fun () -> Client.close client);
          let bus = Client.subscription client in
          let take () =
            let resource =
              Result.get_ok (Identifiers.Resource_id.of_string "res-1")
            in
            Subscription.hold_scope bus
              {
                resource;
                channels =
                  [ Bus_registry.Channel Bus_registry.Channels.mark_added ];
              }
          in
          match subject with
          | "scopeTaken" | "handoffLinger" ->
              let release = ref ignore in
              act := fun () -> release := take ()
          | "scopeLetGo" ->
              Fiber.fork_daemon ~sw (fun () ->
                  let rec open_ previous =
                    if previous = Subscription.Open then ()
                    else
                      open_ (Subscription.await_state_change bus ~from:previous)
                  in
                  open_ (Subscription.state bus);
                  act := take ();
                  `Stop_daemon)
          | "degradedStream" ->
              Fiber.fork_daemon ~sw (fun () ->
                  let rec read previous =
                    let next =
                      Subscription.await_state_change bus ~from:previous
                    in
                    if next = Subscription.Degraded then incr count;
                    if next <> Subscription.Closed then read next
                  in
                  read Subscription.Initial;
                  `Stop_daemon)
          | _ -> ())
      | ( "heldJobStall" | "invalidationWindow" | "jobFollower" | "jobPoll"
        | "jobPollTimeout" ) as subject -> (
          let session =
            Session.start ~sw ~clock ~initial_token:(Some "token")
              ~renew:(fun ~holding:_ -> Session.Refused)
              ()
          in
          let module Source = struct
            type t = string Eio.Stream.t * string ref

            let read_methods = []

            let single_read (stream, pending) buffer =
              if !pending = "" then pending := Eio.Stream.take stream;
              let length =
                min (Cstruct.length buffer) (String.length !pending)
              in
              Cstruct.blit_from_string !pending 0 buffer 0 length;
              pending :=
                String.sub !pending length (String.length !pending - length);
              length
          end in
          let newest = ref None in
          let frame ?correlation_id channel payload =
            let fields =
              [ ("channel", text channel); ("payload", payload) ]
              @ Option.to_list
                  (Option.map (fun id -> ("correlationId", id)) correlation_id)
            in
            Eio.Stream.add (Option.get !newest)
              ("event: bus-event\ndata: "
              ^ Yojson.Safe.to_string (`Assoc fields)
              ^ "\n\n")
          in
          let read = Yojson.Safe.from_string in
          let call ~sw:_ ~meth:_ ~path ~headers:_ ~body ~progress:_ =
            if path = "/bus/subscribe" then (
              let queue = Eio.Stream.create 16 in
              newest := Some queue;
              ( 200,
                [],
                Eio.Resource.T
                  ((queue, ref ""), Eio.Flow.Pi.source (module Source)) ))
            else (
              assert (path = "/bus/emit");
              let envelope = read body in
              let correlation_id = field "correlationId" envelope in
              let answer = frame ~correlation_id in
              (match string "channel" envelope with
              | "browse:events-requested" ->
                  incr count;
                  answer "browse:events-result"
                    (read
                       {|{"response":{"events":[],"total":0,"resourceId":"res-1","lastSequence":0}}|})
              | "job:create" ->
                  answer "job:created" (read {|{"response":{"jobId":"job-1"}}|})
              | "job:status-requested" ->
                  if subject <> "jobPollTimeout" then incr count;
                  answer "job:status-result"
                    (read
                       {|{"response":{"jobId":"job-1","type":"mark","status":"running","userId":"did:web:kb.example:users:one","created":"2026-01-01T00:00:00Z"}}|})
              | "job:claim" ->
                  answer "job:claimed"
                    (read
                       {|{"response":{"status":"running","metadata":{"id":"job-1","type":"mark","userId":"did:web:kb.example:users:one","created":"2026-01-01T00:00:00Z","retryCount":0,"maxRetries":3},"params":{"resourceId":"res-1","motivation":"highlighting"},"startedAt":"2026-01-01T00:00:01Z","progress":{}}}|})
              | "job:report-progress" -> ()
              | other -> failwith ("unexpected clock-test request " ^ other));
              (202, [], Eio.Flow.string_source "{}"))
          in
          let serial = ref 0 in
          let client =
            Client.connect ~sw ~clock ~session ~client_id:"clock-test"
              ~key:(fun () ->
                incr serial;
                "clock-" ^ string_of_int !serial)
              ~call ~global:Bus_registry.bridged_channels ~on_event:ignore ()
          in
          (cleanup := fun () -> Client.close client);
          let resource =
            Result.get_ok (Identifiers.Resource_id.of_string "res-1")
          in
          match subject with
          | "invalidationWindow" ->
              let _release =
                Client.observe
                  (Client.Browse.events client resource)
                  ~on_state:ignore ~on_close:ignore
              in
              act :=
                fun () ->
                  frame "mark:added"
                    (read {|{"type":"mark:added","resourceId":"res-1"}|})
          | "jobFollower" ->
              let params =
                Result.get_ok
                  (Models.decode Models.mark_job_params
                     {|{"motivation":"highlighting"}|})
              in
              let _release =
                Client.Mark.delegate (Client.delegation client) ~resource
                  ~params
                  ~on_report:(fun _ _ -> ())
                  ~on_failure:(fun failure -> failwith failure.Delegation.code)
                  ~on_close:ignore ()
              in
              act :=
                fun () ->
                  frame "job:report-progress"
                    (read
                       {|{"resourceId":"res-1","jobId":"job-1","jobType":"mark","percentage":10,"progress":{"percentage":10}}|})
          | "jobPoll" | "jobPollTimeout" ->
              let job =
                Result.get_ok
                  (Bus_registry.decode
                     Bus_registry.Channels.job_status_requested
                     {|{"jobId":"job-1"}|})
              in
              Fiber.fork_daemon ~sw (fun () ->
                  (match
                     ( subject,
                       Client.Job.poll_until_complete client ~on_status:ignore
                         job )
                   with
                  | ( "jobPollTimeout",
                      Error (Client.Transport Subscription.Timeout) ) ->
                      incr count
                  | "jobPollTimeout", _ ->
                      Alcotest.fail "the poll did not time out"
                  | _ -> ());
                  `Stop_daemon)
          | _ ->
              let filter =
                Result.get_ok
                  (Models.decode Models.job_filter
                     {|{"jobType":"mark","params":{"motivation":"highlighting"}}|})
              in
              let claims = Client.Job.claim client [ filter ] in
              let _release =
                Claims.stalled claims
                  ~on_value:(fun _ -> incr count)
                  ~on_close:ignore
              in
              Fiber.fork_daemon ~sw (fun () ->
                  let job = Option.get (Claims.next claims) in
                  (act :=
                     fun () -> Worker.progress job ~percentage:10 ~message:None);
                  `Stop_daemon))
      | ("refusedBusRequest" | "timedOutBusRequest") as subject ->
          let count_attempts = subject = "refusedBusRequest" in
          let clock = Clock.with_jitter clock (fun () -> 0.) in
          let session =
            Session.start ~sw ~clock ~initial_token:(Some "token")
              ~renew:(fun ~holding:_ -> Session.Refused)
              ()
          in
          let transport =
            Testing.transport ~sw ~clock ~schedule:[]
              ~respond:(fun ~channel:_ _ -> None)
          in
          let fallback = Testing.call transport in
          let retry_after = int "retryAfterSeconds" (field "given" row) in
          let call ~sw ~meth ~path ~headers ~body ~progress =
            if path = "/bus/emit" then (
              if count_attempts then incr count;
              ( 503,
                [ ("retry-after", string_of_int retry_after) ],
                Eio.Flow.string_source "{}" ))
            else fallback ~sw ~meth ~path ~headers ~body ~progress
          in
          let client =
            Client.connect ~sw ~clock ~session ~client_id:"clock-test"
              ~key:(fun () -> "clock-request")
              ~call ~global:Bus_registry.bridged_channels ~on_event:ignore ()
          in
          (cleanup :=
             fun () ->
               Client.close client;
               Session.close session);
          Fiber.fork_daemon ~sw (fun () ->
              (match
                 Client.request client
                   Bus_registry.Operations.browse_events_requested
                   {|{"resourceId":"res-1"}|}
               with
              | Error Subscription.Timeout ->
                  if not count_attempts then incr count
              | _ -> Alcotest.fail "request did not time out");
              `Stop_daemon)
      | ("unansweredRequest" | "unansweredEmit") as subject ->
          let emit = subject = "unansweredEmit" in
          let clock = Clock.with_jitter clock (fun () -> 0.) in
          let session =
            Session.start ~sw ~clock ~initial_token:(Some "token")
              ~renew:(fun ~holding:_ -> Session.Refused)
              ()
          in
          let never, _ = Promise.create () in
          let attempts = ref 0 in
          let call ~sw:_ ~meth:_ ~path ~headers:_ ~body:_ ~progress:_ =
            assert (path = if emit then "/bus/emit" else "/api/health");
            incr attempts;
            if emit then incr count;
            Promise.await never
          in
          let http =
            Http_wire.make ~clock ~session
              ~key:(fun () -> "clock-test")
              ~on_error:ignore ~call ()
          in
          Fiber.fork_daemon ~sw (fun () ->
              (try
                 if emit then
                   ignore
                     (Http_wire.emit http ~client_id:"clock-test"
                        Bus_registry.Channels.beckon_sparkle
                        {|{"annotationId":"ann-1"}|})
                 else ignore (Http_wire.health http)
               with Http_wire.Failed failure ->
                 assert (failure.code = "unavailable");
                 if not emit then (
                   assert (!attempts = 1);
                   incr count));
              `Stop_daemon)
      | "deviceGrant" ->
          let given = field "given" row in
          let endpoint = "https://issuer.example/token" in
          let issuer =
            Result.get_ok
              (OAuth.discover ~issuer:"https://issuer.example" (fun _ ->
                   ( 200,
                     {|{"issuer":"https://issuer.example","authorization_endpoint":"https://issuer.example/auth","token_endpoint":"https://issuer.example/token","device_authorization_endpoint":"https://issuer.example/device"}|}
                   )))
          in
          let fields =
            [
              ("device_code", text "device");
              ("user_code", text "USER");
              ("verification_uri", text "https://issuer.example/verify");
              ("expires_in", `Int 900);
            ]
          in
          let fields =
            match field "intervalSeconds" given with
            | `Int n -> ("interval", `Int n) :: fields
            | _ -> fields
          in
          let device =
            Result.get_ok
              (OAuth.begin_device
                 (fun _ -> (200, Yojson.Safe.to_string (`Assoc fields)))
                 issuer)
          in
          let errors = rows "answers" given in
          Fiber.fork_daemon ~sw (fun () ->
              ignore
                (OAuth.await_device ~clock
                   (fun (request : OAuth.request) ->
                     assert (request.url = endpoint);
                     let code =
                       List.nth errors (min !count (List.length errors - 1))
                     in
                     incr count;
                     (400, Yojson.Safe.to_string (`Assoc [ ("error", code) ])))
                   issuer device);
              `Stop_daemon)
      | _ -> assert false);
      let settle () =
        for _ = 1 to 20 do
          Fiber.yield ()
        done
      in
      settle ();
      List.iter
        (fun step ->
          if step = text "act" then (
            !act ();
            settle ())
          else
            match field "counted" step with
            | `Int expected ->
                Alcotest.(check int) (string "case" row) expected !count
            | _ ->
                let elapsed = elapsed (field "pass" step) in
                Eio_mock.Clock.set_time wall
                  (Clock.wall_now clock +. (float elapsed /. 1000.));
                Eio_mock.Clock.Mono.set_time mono
                  (Option.get
                     (Mtime.add_span
                        (Clock.monotonic_now clock)
                        Mtime.Span.(elapsed * ms)));
                settle ())
        (rows "steps" row);
      !cleanup ();
      settle ())
    table

let sign_in () =
  Eio_main.run @@ fun env ->
  let clock =
    Clock.make
      ~monotonic:(Eio.Stdenv.mono_clock env)
      ~wall:(Eio.Stdenv.clock env)
      ~jitter:(Random.State.make [| 1 |])
  in
  let values = Hashtbl.create 8 in
  let storage : R.storage =
    {
      read = Hashtbl.find_opt values;
      write = Hashtbl.replace values;
      remove = Hashtbl.remove values;
    }
  in
  let serial = ref 0 in
  let browser =
    R.new_semiont_browser
      {
        storage;
        clock;
        fresh_id =
          (fun () ->
            incr serial;
            "kb-" ^ string_of_int !serial);
        factory = (fun _ -> assert false);
      }
  in
  let endpoint port =
    decode Models.kb_endpoint
      (`Assoc
         [
           ("kind", text "http");
           ("host", text "localhost");
           ("port", `Int port);
           ("protocol", text "http");
         ])
  in
  let description domain =
    decode Models.kb_description
      (`Assoc [ ("name", text domain); ("domain", text domain) ])
  in
  let record port domain access =
    R.record_sign_in browser
      {
        endpoint = endpoint port;
        description = description domain;
        session =
          {
            access;
            refresh = "refresh";
            client_id = "script";
            token_endpoint = "https://issuer.example/token";
            revocation_endpoint = None;
          };
        kb_id = Some "kb-1";
        expected_did = Some "did:web:one.example";
        expected_name = None;
      }
  in
  let sign port domain access = Result.get_ok (record port domain access) in
  let id (outcome : R.sign_in_outcome) =
    (Records.Knowledge_base.of_model outcome.kb).id
  in
  assert (record 4010 "" "unnamed" = Error Error_codes.Kb_identity.not_reported);
  assert (id (sign 4010 "one.example" "first") = "kb-1");
  assert (id (sign 4010 "one.example" "new") = "kb-1");
  assert (id (sign 4011 "one.example" "different-address") = "kb-2");
  assert (id (sign 4010 "other.example" "different-identity") = "kb-3");
  assert ((Option.get (R.stored_session storage "kb-1")).access = "new");
  R.sign_out browser "kb-3";
  assert (R.active_id browser = None && R.stored_session storage "kb-3" = None)

let redirect () =
  Eio_mock.Backend.run @@ fun () ->
  let clock =
    Clock.make
      ~monotonic:(Eio_mock.Clock.Mono.make ())
      ~wall:(Eio_mock.Clock.make ())
      ~jitter:(Random.State.make [| 1 |])
  in
  let data = Hashtbl.create 4 in
  let storage : R.storage =
    {
      read = Hashtbl.find_opt data;
      write = Hashtbl.replace data;
      remove = Hashtbl.remove data;
    }
  in
  let takes = ref 0 in
  let atomic_storage =
    Storage.make ~get:storage.read
      ~update:(fun key change ->
        match change (storage.read key) with
        | Some value -> storage.write key value
        | None ->
            if key = R.pending_authorization_key then incr takes;
            storage.remove key)
      ()
  in
  let config : R.semiont_browser_config =
    {
      storage;
      clock;
      fresh_id = (fun () -> "kb-redirect");
      factory = (fun _ -> assert false);
    }
  in
  let target =
    decode Models.kb_endpoint
      (Yojson.Safe.from_string
         {|{"kind":"http","host":"localhost","port":4010,"protocol":"http"}|})
  in
  let description =
    decode Models.kb_description
      (Yojson.Safe.from_string {|{"name":"Actual","domain":"kb.example"}|})
  in
  let discovery = ref 0 and exchanges = ref 0 in
  let issued =
    ref (200, {|{"access_token":"access","refresh_token":"refresh"}|})
  in
  let http (request : OAuth.request) =
    match request.meth with
    | "GET" ->
        incr discovery;
        ( 200,
          {|{"issuer":"https://issuer.example","authorization_endpoint":"https://issuer.example/auth","token_endpoint":"https://issuer.example/token","revocation_endpoint":"https://issuer.example/revoke"}|}
        )
    | "POST" ->
        incr exchanges;
        assert (request.url = "https://issuer.example/token");
        assert (List.assoc "code" request.form = "one");
        assert (List.assoc "code_verifier" request.form <> "");
        !issued
    | _ -> assert false
  in
  let origin = "http://localhost:4010/callback" in
  let begin_ () =
    let count = ref 0 in
    let random length =
      incr count;
      String.make length (Char.chr !count)
    in
    R.begin_sign_in
      (R.new_semiont_browser ~storage:atomic_storage config)
      ~http ~issuer:"https://issuer.example" ~random ~redirect_uri:origin
      ~target ~expected_did:"did:web:expected.example" ()
    |> Result.get_ok |> Uri.of_string
  in
  let complete callback =
    R.complete_sign_in (R.new_semiont_browser ~storage:atomic_storage config)
      ~http ~callback ~describe:(fun endpoint ~access ->
        assert (R.same_place endpoint target && access = "access");
        Ok description)
  in
  let location = begin_ () in
  let state = Option.get (Uri.get_query_param location "state") in
  let callback = origin ^ "?code=one&state=" ^ state in
  let module Code = Error_codes.Sign_in in
  assert (complete (callback ^ "bad") = Error Code.state);
  assert (complete callback = Error Code.no_pending);
  assert (!exchanges = 0);
  ignore (begin_ ());
  let outcome = Result.get_ok (complete callback) in
  assert ((Option.get outcome.expected).did = "did:web:expected.example");
  assert ((Records.Knowledge_base.of_model outcome.kb).id = "kb-redirect");
  let kept = Option.get ((R.kept_in storage "kb-redirect").held ()) in
  assert (kept.access = "access" && kept.refresh = "refresh");
  assert (kept.revocation_endpoint = Some "https://issuer.example/revoke");
  assert (complete callback = Error Code.no_pending);
  (* Each sign-in below is begun afresh, and the callback or the issuer's
     answer fails it. *)
  let failed callback =
    ignore (begin_ ());
    complete callback
  in
  assert (
    failed (origin ^ "?error=access_denied&state=" ^ state) = Error Code.denied);
  assert (
    failed (origin ^ "?error=server_error&state=" ^ state) = Error Code.exchange);
  assert (failed (origin ^ "?state=" ^ state) = Error Code.exchange);
  issued := (400, {|{"error":"invalid_grant"}|});
  assert (failed callback = Error Code.exchange);
  issued := (200, {|{"access_token":"access"}|});
  assert (failed callback = Error Code.exchange);
  issued := (200, "{}");
  assert (failed callback = Error Code.exchange);
  ignore (begin_ ());
  let pending = Option.get (storage.read R.pending_authorization_key) in
  storage.write R.pending_authorization_key
    (match Yojson.Safe.from_string pending with
    | `Assoc fields ->
        Yojson.Safe.to_string
          (`Assoc (("target", `Null) :: List.remove_assoc "target" fields))
    | _ -> assert false);
  assert (complete callback = Error Code.no_pending);
  assert (!discovery = 9 && !exchanges = 4 && !takes = 11)

let session_unit startup () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let clock =
    Clock.make
      ~monotonic:(Eio_mock.Clock.Mono.make ())
      ~wall:(Eio_mock.Clock.make ())
      ~jitter:(Random.State.make [| 1 |])
  in
  let data = Hashtbl.create 4 in
  let storage : R.storage =
    {
      read = Hashtbl.find_opt data;
      write = Hashtbl.replace data;
      remove = Hashtbl.remove data;
    }
  in
  let browser =
    R.new_semiont_browser
      {
        storage;
        clock;
        fresh_id = (fun () -> "kb");
        factory = (fun _ -> assert false);
      }
  in
  let target =
    decode Models.kb_endpoint
      (Yojson.Safe.from_string
         {|{"kind":"http","host":"localhost","port":4010,"protocol":"http"}|})
  in
  let description =
    decode Models.kb_description
      (Yojson.Safe.from_string {|{"name":"Actual","domain":"kb.example"}|})
  in
  let stored : R.stored_session =
    {
      access = "original";
      refresh = "initial-refresh";
      client_id = "browser";
      token_endpoint = "https://issuer.example/token";
      revocation_endpoint = None;
    }
  in
  let registered =
    Result.get_ok
      (R.record_sign_in browser
         {
           endpoint = target;
           description;
           session = stored;
           kb_id = None;
           expected_did = None;
           expected_name = None;
         })
  in
  let kept = R.kept_in storage "kb" in
  let renewals = ref 0 in
  let issuer (request : OAuth.request) =
    incr renewals;
    assert (request.url = stored.token_endpoint);
    assert (List.assoc "client_id" request.form = "browser");
    if !renewals = 1 then (
      assert (List.assoc "refresh_token" request.form = "initial-refresh");
      (200, {|{"access_token":"next","refresh_token":"rotated"}|}))
    else (
      assert (List.assoc "refresh_token" request.form = "rotated");
      (400, {|{"error":"invalid_grant"}|}))
  in
  let credentials = R.start_kept_session browser ~sw ~http:issuer "kb" in
  let asks = ref 0 in
  let call ~sw:_ ~meth:_ ~path ~headers ~body:_ ~progress:_ =
    match path with
    | "/bus/subscribe" ->
        (* The stream opener waits here while the test drives credential changes. *)
        Eio.Fiber.await_cancel ()
    | "/api/users/me" ->
        incr asks;
        let bearer = List.assoc "authorization" headers in
        if startup = `Reject || (startup = `Renew && bearer = "Bearer original")
        then (401, [], Eio.Flow.string_source "{}")
        else (
          assert (List.mem bearer [ "Bearer original"; "Bearer next" ]);
          ( 200,
            [],
            Eio.Flow.string_source
              {|{"did":"did:web:kb.example:users:alice","email":null,"name":"Alice","image":null,"domain":"kb.example"}|}
          ))
    | _ -> assert false
  in
  let client =
    Client.connect ~sw ~clock ~session:credentials ~client_id:"test"
      ~key:(fun () -> "test")
      ~call ~global:Bus_registry.bridged_channels ~on_event:ignore ()
  in
  let module S = State_units.Session in
  let unit = S.make ~id:"kb" ~kb:registered.kb client in
  S.ready unit;
  (match startup with
  | `Reject ->
      assert (!asks = 2 && !renewals = 1 && kept.held () = None);
      assert (
        State_value.get (S.token unit) = None
        && State_value.get (S.user unit) = None)
  | `Renew ->
      assert (!asks = 2 && !renewals = 1);
      assert (State_value.get (S.token unit) = Some "next");
      assert (Option.is_some (State_value.get (S.user unit)))
  | `Accept ->
      assert (State_value.get (S.token unit) = Some "original");
      assert (Option.is_some (State_value.get (S.user unit)));
      assert (S.refresh unit ~refused:"original" () = Some "next");
      assert ((Option.get (kept.held ())).refresh = "rotated");
      assert (
        S.refresh unit ~refused:"original" () = Some "next" && !renewals = 1);
      assert (S.refresh unit ~refused:"next" () = None);
      assert (kept.held () = None && !renewals = 2));
  S.dispose unit;
  assert (
    State_value.get (S.token unit) = None
    && State_value.get (S.user unit) = None);
  assert (Subscription.state (Client.subscription client) <> Subscription.Closed);
  Client.close client;
  Client.await_closed client

(* A worker's claims over the testing transport. [answer] answers each request
   the claims make, handed the transport so it can announce the queue. *)
let claims_over ~sw ~clock ?timeout_ms ?stall_ms ?stall_check_ms answer =
  let transport = ref None in
  let testing =
    Testing.transport ~sw ~clock ~schedule:[] ~respond:(fun ~channel payload ->
        answer (Option.get !transport) ~channel payload)
  in
  transport := Some testing;
  let session =
    Session.start ~sw ~clock ~initial_token:(Some "token")
      ~renew:(fun ~holding:_ -> Session.Refused)
      ()
  in
  let serial = ref 0 in
  let client =
    Client.connect ~sw ~clock ~session ~client_id:"claims"
      ~key:(fun () ->
        incr serial;
        "claims-" ^ string_of_int !serial)
      ~call:(Testing.call testing) ~global:Claims.job_claim_channels
      ~on_event:ignore ()
  in
  let filter =
    decode Models.job_filter
      (`Assoc
         [
           ("jobType", text "mark");
           ("params", `Assoc [ ("motivation", text "highlighting") ]);
         ])
  in
  ( client,
    Client.Job.claim client ?timeout_ms ?stall_ms ?stall_check_ms [ filter ] )

let queued =
  `Assoc
    [
      ("jobId", text "job-queued");
      ("jobType", text "mark");
      ("resourceId", text "res-1");
      ("userId", text "did:web:kb.example:users:one");
      ("params", `Assoc [ ("motivation", text "highlighting") ]);
    ]

let mock_clock () =
  let mono = Eio_mock.Clock.Mono.make () in
  ( mono,
    Clock.make ~monotonic:mono ~wall:(Eio_mock.Clock.make ())
      ~jitter:(Random.State.make [| 1 |]) )

let pass mono clock elapsed_ms =
  Eio_mock.Clock.Mono.set_time mono
    (Option.get
       (Mtime.add_span (Clock.monotonic_now clock) Mtime.Span.(elapsed_ms * ms)));
  for _ = 1 to 20 do
    Fiber.yield ()
  done

(* client/timing.json, errorsKeptForFirstReaderCount: how many of what a stream
   said before its first reader came that reader is given, the oldest dropped. *)
let kept =
  int "errorsKeptForFirstReaderCount"
    (Yojson.Safe.from_string Registry_cases.timing)

let claims_refused () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono, clock = mock_clock () in
  let code index =
    if index = 0 then Some "not-found"
    else if index = 1 then Some "peer-unavailable"
    else if index = kept then Some "unauthorized"
    else None
  in
  let said index =
    Some (Option.fold ~none:"bus.rejected" ~some:(( ^ ) "bus.") (code index))
  in
  let claim_timeout_ms = 10 in
  let all_said, said_all = Promise.create () in
  let answered = ref 0 in
  let client, claims =
    claims_over ~sw ~clock ~timeout_ms:claim_timeout_ms
      (fun transport ~channel _ ->
        assert (channel = "job:claim");
        let index = !answered in
        incr answered;
        if index > kept then (
          Promise.resolve said_all ();
          None)
        else (
          Testing.deliver transport "job:queued" queued;
          Some
            ( "job:claim-failed",
              `Assoc
                (("message", text "refused")
                :: Option.to_list
                     (Option.map (fun code -> ("code", text code)) (code index))
                ) )))
  in
  Fiber.fork ~sw (fun () -> assert (Option.is_none (Claims.next claims)));
  Promise.await all_said;
  let first = ref [] and later = Eio.Stream.create max_int and ended = ref [] in
  let _release =
    Claims.refused claims
      ~on_value:(fun code -> first := code :: !first)
      ~on_close:(fun () -> ended := "first" :: !ended)
  in
  let _release =
    Claims.refused claims ~on_value:(Eio.Stream.add later) ~on_close:(fun () ->
        ended := "later" :: !ended)
  in
  let let_go =
    Claims.refused claims
      ~on_value:(fun _ -> Alcotest.fail "a reader that let go heard a refusal")
      ~on_close:(fun () -> Alcotest.fail "a reader that let go heard the end")
  in
  let_go ();
  let refused = Alcotest.(list (option string)) in
  Alcotest.check refused
    "the first reader hears the latest kept in order, the oldest dropped"
    (List.init kept (fun index -> said (index + 1)))
    (List.rev !first);
  Alcotest.(check bool)
    "a later reader hears nothing said before it" true
    (Eio.Stream.is_empty later);
  pass mono clock (2 * claim_timeout_ms);
  let timed_out = Some "bus.timeout" in
  Alcotest.(check (option string))
    "a later reader hears what is said after" timed_out (Eio.Stream.take later);
  Alcotest.check refused "the first reader hears what is said after"
    (List.init kept (fun index -> said (index + 1)) @ [ timed_out ])
    (List.rev !first);
  Claims.stop claims;
  Alcotest.(check (list string))
    "each reader hears the end" [ "first"; "later" ] (List.sort compare !ended);
  let told_end = ref false in
  let _release =
    Claims.refused claims
      ~on_value:(fun _ ->
        Alcotest.fail "a reader after the end heard a refusal")
      ~on_close:(fun () -> told_end := true)
  in
  Alcotest.(check bool)
    "a reader after the end hears only the end" true !told_end;
  Client.close client

let claims_stalled () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono, clock = mock_clock () in
  let stall_ms = 10 in
  let claimed = ref 0 in
  let held_job id =
    `Assoc
      [
        ( "response",
          `Assoc
            [
              ("status", text "running");
              ( "metadata",
                `Assoc
                  [
                    ("id", text id);
                    ("type", text "mark");
                    ("userId", text "did:web:kb.example:users:one");
                    ("created", text "2026-01-01T00:00:00Z");
                    ("retryCount", `Int 0);
                    ("maxRetries", `Int 3);
                  ] );
              ( "params",
                `Assoc
                  [
                    ("resourceId", text "res-1");
                    ("motivation", text "highlighting");
                  ] );
              ("startedAt", text "2026-01-01T00:00:01Z");
              ("progress", `Assoc []);
            ] );
      ]
  in
  let client, claims =
    claims_over ~sw ~clock ~stall_ms ~stall_check_ms:1 (fun _ ~channel _ ->
        match channel with
        | "job:claim" ->
            incr claimed;
            Some ("job:claimed", held_job ("job-" ^ string_of_int !claimed))
        | _ -> None)
  in
  let held = Eio.Stream.create max_int in
  Fiber.fork ~sw (fun () ->
      let rec consume () =
        match Claims.next claims with
        | Some job ->
            Eio.Stream.add held job;
            consume ()
        | None -> ()
      in
      consume ());
  let stall () =
    let job = Eio.Stream.take held in
    pass mono clock (2 * stall_ms);
    job
  in
  let settle job =
    Worker.fail job ~error:"stalled" ~failure_class:None ~completed:None
      ~cursors:None
  in
  settle (stall ());
  let second = stall () in
  let first = ref [] and later = Eio.Stream.create max_int and ended = ref [] in
  let _release =
    Claims.stalled claims
      ~on_value:(fun job -> first := Worker.id job :: !first)
      ~on_close:(fun () -> ended := "first" :: !ended)
  in
  let _release =
    Claims.stalled claims
      ~on_value:(fun job -> Eio.Stream.add later (Worker.id job))
      ~on_close:(fun () -> ended := "later" :: !ended)
  in
  let jobs = Alcotest.(list string) in
  Alcotest.check jobs "a first reader taken late hears each stall, in order"
    [ "job-1"; "job-2" ] (List.rev !first);
  Alcotest.(check bool)
    "a later reader hears no stall said before it" true
    (Eio.Stream.is_empty later);
  settle second;
  ignore (stall ());
  Alcotest.(check string)
    "a later reader hears the stall said after" "job-3" (Eio.Stream.take later);
  Alcotest.check jobs "the first reader hears the stall said after"
    [ "job-1"; "job-2"; "job-3" ]
    (List.rev !first);
  Claims.stop claims;
  Alcotest.(check (list string))
    "each reader hears the end" [ "first"; "later" ] (List.sort compare !ended);
  let told_end = ref false in
  let _release =
    Claims.stalled claims
      ~on_value:(fun _ -> Alcotest.fail "a reader after the end heard a stall")
      ~on_close:(fun () -> told_end := true)
  in
  Alcotest.(check bool)
    "a reader after the end hears only the end" true !told_end;
  Client.close client

(* protocol/specs/src/session/registry-errors-cases.json: a registry reads the
   errors of each session it activates, from the first thing the session said,
   over a factory that builds a scripted session and reads none of them. *)
let errors_table = Yojson.Safe.from_string Registry_cases.errors_cases

let errors_kb =
  decode Models.knowledge_base
    (`Assoc
       [
         ("id", text "kb-a");
         ("label", text "KB A");
         ("did", text "did:web:kb.example.org:kb-a");
         ( "endpoint",
           `Assoc
             [
               ("kind", text "http");
               ("host", text "kb.example.org");
               ("port", `Int 443);
               ("protocol", text "https");
             ] );
       ])

let errors_identity : R.connection_identity =
  {
    did = "did:web:kb.example.org:kb-a";
    description =
      decode Models.kb_description
        (`Assoc [ ("name", text "KB A"); ("domain", text "kb.example.org") ]);
  }

let errors_browser ~clock factory =
  let values = Hashtbl.create 4 in
  let storage : R.storage =
    {
      read = Hashtbl.find_opt values;
      write = Hashtbl.replace values;
      remove = Hashtbl.remove values;
    }
  in
  R.save_knowledge_bases storage [ errors_kb ];
  R.new_semiont_browser
    { storage; clock; fresh_id = (fun () -> "kb-fresh"); factory }

(* The knowledge base's session over the testing transport: the gateway names
   one person, and each renewal records the token it is handed. Its client
   keeps in [persister] when given one. *)
let scripted_session ~sw ~clock ~handed ?persister
    (options : R.session_factory_options) =
  let transport =
    Testing.transport ~sw ~clock ~schedule:[] ~respond:(fun ~channel:_ _ ->
        None)
  in
  let credentials =
    Session.start ~sw ~clock ~initial_token:(Some "token")
      ~renew:(fun ~holding ->
        handed := !handed @ [ holding ];
        Session.Refused)
      ()
  in
  let content ~meth:_ ~path ~headers:_ ~body:_ =
    match path with
    | "/api/users/me" ->
        ( 200,
          [],
          Eio.Flow.string_source
            {|{"did":"did:web:kb.example.org:users:jo","email":null,"name":"Jo","image":null,"domain":"kb.example.org"}|}
        )
    | "/resources/res-1/annotations" ->
        (200, [], Eio.Flow.string_source {|{"annotations":[]}|})
    | _ -> Alcotest.fail ("fetches an unexpected path " ^ path)
  in
  let client =
    Client.connect ~sw ~clock ~session:credentials ~client_id:"kb-a"
      ~key:(fun () -> "key")
      ~call:(Testing.call ~content transport)
      ?persister ~global:Bus_registry.bridged_channels ~on_event:ignore ()
  in
  State_units.Session.make ~id:"session-a" ~kb:options.kb client

let saying value : Client.said =
  match (field "own" value, field "transport" value) with
  | `String code, `Null -> Own { code; message = "the session says " ^ code }
  | `Null, `String code ->
      Transport_failure
        { code; status = None; message = string "message" value }
  | _ -> Alcotest.fail "says neither an own error nor a transport failure"

let registry_errors_case row () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let _, clock = mock_clock () in
  let why = string "why" row in
  let said = List.map saying (rows "said" row) in
  let opening =
    match string "while" row with
    | "opening" -> true
    | "active" -> false
    | other -> Alcotest.fail (why ^ ": says what it says while " ^ other)
  in
  let handed = ref [] in
  let built = ref None in
  let script = Testing.scripted_sessions () in
  Testing.queue_session script "kb-a" (fun options ->
      let session = scripted_session ~sw ~clock ~handed options in
      built := Some (session, options.signals);
      if opening then List.iter (Testing.say_on session) said;
      Ok (session, errors_identity));
  let browser = errors_browser ~clock (Testing.factory script) in
  let registry_said = ref [] in
  let _release =
    R.errors browser
      ~on_value:(fun (error : Client.session_error) ->
        registry_said := !registry_said @ [ error.code ])
      ~on_close:ignore
  in
  (match R.activate browser "kb-a" with
  | Ok _ -> ()
  | Error _ -> Alcotest.fail (why ^ ": the registry activated no session"));
  let session, signals = Option.get !built in
  State_units.Session.ready session;
  if not opening then List.iter (Testing.say_on session) said;
  Alcotest.(check (list string))
    (why ^ ": said on the registry's errors")
    (List.map J.to_string (rows "registryErrors" row))
    !registry_said;
  Alcotest.(check (list (option string)))
    (why ^ ": tokens a renewal was handed")
    [] !handed;
  Alcotest.(check (option (option string)))
    (why ^ ": said through the signals as a refusal for lack of permission")
    (Option.map Option.some (J.to_string_option (field "permissionDenied" row)))
    (Option.map
       (fun (denied : State_units.Session_signals.permission_denied) ->
         denied.detail)
       (State_value.get (State_units.Session_signals.permission_denied signals)));
  R.close browser;
  Client.await_closed (State_units.Session.client session)

(* The closing rows: the session's client keeps in a storage that refuses every
   write. The monotonic clock never moves, so the save a read leaves owed is
   still waiting out its debounce as the close begins. *)
let registry_closing row () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let _, clock = mock_clock () in
  let why = string "why" row in
  let refusing =
    Storage.make
      ~get:(fun _ -> None)
      ~update:(fun _ _ -> failwith "the storage refuses every write")
      ()
  in
  let persister =
    Storage_persister.make ~storage:refusing ~key:"kept" ~version:1
      ~max_bytes:8192 ~clock
  in
  let handed = ref [] in
  let built = ref None in
  let script = Testing.scripted_sessions () in
  Testing.queue_session script "kb-a" (fun options ->
      let session = scripted_session ~sw ~clock ~handed ~persister options in
      built := Some session;
      Ok (session, errors_identity));
  let browser = errors_browser ~clock (Testing.factory script) in
  let registry_said = ref [] in
  let ended = ref false in
  let _release =
    R.errors browser
      ~on_value:(fun (error : Client.session_error) ->
        registry_said := !registry_said @ [ error.code ])
      ~on_close:(fun () -> ended := true)
  in
  (match R.activate browser "kb-a" with
  | Ok _ -> ()
  | Error _ -> Alcotest.fail (why ^ ": the registry activated no session"));
  let session = Option.get !built in
  State_units.Session.ready session;
  let client = State_units.Session.client session in
  (if J.to_bool (field "owed" row) then
     let resource = Result.get_ok (Identifiers.Resource_id.of_string "res-1") in
     match Client.fresh (Client.Browse.annotations client resource) with
     | Ok _ -> ()
     | Error _ -> Alcotest.fail (why ^ ": the read the save is owed for failed"));
  let before = List.length !registry_said in
  R.close browser;
  Alcotest.(check bool) (why ^ ": the registry's errors end") true !ended;
  Alcotest.(check (list string))
    (why ^ ": said on the registry's errors as it closed")
    (List.map J.to_string (rows "registryErrors" row))
    (List.filteri (fun index _ -> index >= before) !registry_said);
  Client.await_closed client

(* A factory that cannot build the knowledge base's session: the registry says
   so on its errors, and the activation is unavailable for the factory's
   reason. *)
let registry_construct_failed () =
  Eio_mock.Backend.run @@ fun () ->
  let _, clock = mock_clock () in
  let script = Testing.scripted_sessions () in
  Testing.queue_session script "kb-a" (fun _ ->
      Error Error_codes.Transport.unavailable);
  let browser = errors_browser ~clock (Testing.factory script) in
  let registry_said = ref [] in
  let _release =
    R.errors browser
      ~on_value:(fun (error : Client.session_error) ->
        registry_said := !registry_said @ [ error.code ])
      ~on_close:ignore
  in
  (match R.activate browser "kb-a" with
  | Error (R.Unavailable code) when code = Error_codes.Transport.unavailable ->
      ()
  | _ ->
      Alcotest.fail
        "an activation whose factory failed was not unavailable for its reason");
  Alcotest.(check (list string))
    "said on the registry's errors"
    [ Error_codes.Session.construct_failed ]
    !registry_said;
  R.close browser

(* A registry that has closed builds no session. *)
let registry_closed_activation () =
  Eio_mock.Backend.run @@ fun () ->
  let _, clock = mock_clock () in
  let built = ref false in
  let browser =
    errors_browser ~clock (fun _ ->
        built := true;
        Error Error_codes.Session.construct_failed)
  in
  R.close browser;
  (match R.activate browser "kb-a" with
  | Error R.Superseded -> ()
  | _ -> Alcotest.fail "an activation after the registry closed was not over");
  Alcotest.(check bool) "a session built after the close" false !built

let refusal index = "refusal " ^ string_of_int index

(* A client's errors keep the latest failures of its transport for their first
   reader: here each a refusal of the gateway's health. *)
let client_errors_kept () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let _, clock = mock_clock () in
  let transport =
    Testing.transport ~sw ~clock ~schedule:[] ~respond:(fun ~channel:_ _ ->
        None)
  in
  let refused = ref 0 in
  let content ~meth:_ ~path ~headers:_ ~body:_ =
    match path with
    | "/api/health" ->
        incr refused;
        ( 403,
          [],
          Eio.Flow.string_source
            (Yojson.Safe.to_string
               (`Assoc [ ("error", text (refusal !refused)) ])) )
    | _ -> Alcotest.fail ("fetches an unexpected path " ^ path)
  in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some "token")
      ~renew:(fun ~holding:_ -> Session.Refused)
      ()
  in
  let client =
    Client.connect ~sw ~clock ~session ~client_id:"client-a"
      ~key:(fun () -> "key")
      ~call:(Testing.call ~content transport)
      ~global:Bus_registry.bridged_channels ~on_event:ignore ()
  in
  let refuse () =
    match Http_wire.health (Client.http client) with
    | _ -> Alcotest.fail "a refusal of the gateway's health was taken as health"
    | exception Http_wire.Failed _ -> ()
  in
  for _ = 1 to kept + 3 do
    refuse ()
  done;
  let heard said =
    match (said : Client.said) with
    | Transport_failure { code = "forbidden"; status = Some 403; message } ->
        message
    | Transport_failure _ ->
        Alcotest.fail "a refusal was said as other than a lack of permission"
    | Own _ -> Alcotest.fail "the client said an error of its own"
  in
  let first = ref [] and later = ref [] and ended = ref [] in
  let _release =
    Client.errors client
      ~on_value:(fun said -> first := !first @ [ heard said ])
      ~on_close:(fun () -> ended := "first" :: !ended)
  in
  let _release =
    Client.errors client
      ~on_value:(fun said -> later := !later @ [ heard said ])
      ~on_close:(fun () -> ended := "later" :: !ended)
  in
  let latest = List.init kept (fun index -> refusal (index + 4)) in
  Alcotest.(check (list string))
    "the first reader hears the latest kept in order, the oldest dropped" latest
    !first;
  Alcotest.(check (list string))
    "a later reader hears nothing said before it" [] !later;
  refuse ();
  let after = refusal (kept + 4) in
  Alcotest.(check (list string))
    "a later reader hears what is said after" [ after ] !later;
  Alcotest.(check (list string))
    "the first reader hears what is said after" (latest @ [ after ]) !first;
  Client.close client;
  Alcotest.(check (list string))
    "each reader hears the end" [ "first"; "later" ] (List.sort compare !ended);
  let told_end = ref false in
  let _release =
    Client.errors client
      ~on_value:(fun _ -> Alcotest.fail "a reader after the end heard an error")
      ~on_close:(fun () -> told_end := true)
  in
  Alcotest.(check bool)
    "a reader after the end hears only the end" true !told_end;
  Client.await_closed client

(* A registry's errors keep the latest of its sessions' own errors for their
   first reader. *)
let registry_errors_kept () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let _, clock = mock_clock () in
  let handed = ref [] in
  let built = ref None in
  let script = Testing.scripted_sessions () in
  Testing.queue_session script "kb-a" (fun options ->
      let session = scripted_session ~sw ~clock ~handed options in
      built := Some session;
      Ok (session, errors_identity));
  let browser = errors_browser ~clock (Testing.factory script) in
  (match R.activate browser "kb-a" with
  | Ok _ -> ()
  | Error _ -> Alcotest.fail "the registry activated no session");
  let session = Option.get !built in
  State_units.Session.ready session;
  let said = ref 0 in
  let say () =
    incr said;
    Testing.say_on session
      (Own { code = "session.save-refused"; message = refusal !said })
  in
  for _ = 1 to kept + 3 do
    say ()
  done;
  let first = ref [] and later = ref [] and ended = ref [] in
  let _release =
    R.errors browser
      ~on_value:(fun (error : Client.session_error) ->
        first := !first @ [ error.message ])
      ~on_close:(fun () -> ended := "first" :: !ended)
  in
  let _release =
    R.errors browser
      ~on_value:(fun (error : Client.session_error) ->
        later := !later @ [ error.message ])
      ~on_close:(fun () -> ended := "later" :: !ended)
  in
  let latest = List.init kept (fun index -> refusal (index + 4)) in
  Alcotest.(check (list string))
    "the first reader hears the latest kept in order, the oldest dropped" latest
    !first;
  Alcotest.(check (list string))
    "a later reader hears nothing said before it" [] !later;
  say ();
  let after = refusal (kept + 4) in
  Alcotest.(check (list string))
    "a later reader hears what is said after" [ after ] !later;
  Alcotest.(check (list string))
    "the first reader hears what is said after" (latest @ [ after ]) !first;
  R.close browser;
  Alcotest.(check (list string))
    "each reader hears the end" [ "first"; "later" ] (List.sort compare !ended);
  let told_end = ref false in
  let _release =
    R.errors browser
      ~on_value:(fun _ -> Alcotest.fail "a reader after the end heard an error")
      ~on_close:(fun () -> told_end := true)
  in
  Alcotest.(check bool)
    "a reader after the end hears only the end" true !told_end;
  Client.await_closed (State_units.Session.client session)

(* What a knowledge base reached with a fresh sign-in says of itself: a refusal
   that names no code it is known to name is its answer that it cannot say
   what it is, any other failure is not having reached it, and a domain no did
   can hold says nothing of who it is. *)
let describe_connection () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let _, clock = mock_clock () in
  let described answer =
    let testing =
      Testing.transport ~sw ~clock ~schedule:[] ~respond:(fun ~channel _ ->
          if channel = "browse:kb-requested" then Some answer else None)
    in
    let session =
      Session.start ~sw ~clock ~initial_token:(Some "token")
        ~renew:(fun ~holding:_ -> Session.Refused)
        ()
    in
    let serial = ref 0 in
    let client =
      Client.connect ~sw ~clock ~session ~client_id:"describe"
        ~key:(fun () ->
          incr serial;
          "describe-" ^ string_of_int !serial)
        ~call:(Testing.call testing) ~global:Bus_registry.bridged_channels
        ~on_event:ignore ()
    in
    let identity = R.describe_connection client in
    Client.close client;
    Result.map (fun (identity : R.connection_identity) -> identity.did) identity
  in
  let refused code =
    ( "browse:kb-failed",
      `Assoc
        (("message", text "no identity is declared")
        :: Option.to_list (Option.map (fun code -> ("code", text code)) code))
    )
  in
  let answered domain =
    ( "browse:kb-result",
      `Assoc
        [
          ("response", `Assoc [ ("name", text "KB"); ("domain", text domain) ]);
        ] )
  in
  let module Code = Error_codes.Kb_identity in
  let check = Alcotest.(check (result string string)) in
  check "an answer names the knowledge base" (Ok "did:web:kb.example")
    (described (answered "kb.example"));
  check "a refusal that names no code" (Error Code.not_reported)
    (described (refused None));
  check "a refusal whose code is none of CommandError's"
    (Error Code.not_reported)
    (described (refused (Some "no-such-code")));
  check "a refusal that names a code" (Error Code.unreachable)
    (described (refused (Some "unauthorized")));
  check "a domain no did can hold" (Error Code.not_reported)
    (described (answered ""))

let () =
  Alcotest.run "OCaml registry and discovery"
    [
      ( "registry",
        [
          Alcotest.test_case "shared cases" `Quick shared;
          Alcotest.test_case "shared gateway origins" `Quick gateway_urls;
          Alcotest.test_case "verified sign-in" `Quick sign_in;
          Alcotest.test_case "durable redirect and replay" `Quick redirect;
          Alcotest.test_case "what a knowledge base says of itself" `Quick
            describe_connection;
          Alcotest.test_case "session unit and durable renewal" `Quick
            (session_unit `Accept);
          Alcotest.test_case "startup refuses once then confirms" `Quick
            (session_unit `Renew);
          Alcotest.test_case "startup rejects a renewed credential" `Quick
            (session_unit `Reject);
        ] );
      ( "discovery",
        [
          Alcotest.test_case "document and diff" `Quick discovery;
          Alcotest.test_case "shared clock" `Quick controlled;
        ] );
      ( "claims",
        [
          Alcotest.test_case "refusals kept for the first reader" `Quick
            claims_refused;
          Alcotest.test_case "stalls kept for the first reader" `Quick
            claims_stalled;
        ] );
      ( "registry errors",
        List.map
          (fun row ->
            Alcotest.test_case
              (string "while" row ^ ": " ^ string "why" row)
              `Quick (registry_errors_case row))
          (rows "cases" errors_table)
        @ List.map
            (fun row ->
              Alcotest.test_case
                ("closing: " ^ string "why" row)
                `Quick (registry_closing row))
            (rows "closing" errors_table)
        @ [
            Alcotest.test_case "a client's errors kept for the first reader"
              `Quick client_errors_kept;
            Alcotest.test_case "a registry's errors kept for the first reader"
              `Quick registry_errors_kept;
            Alcotest.test_case "a session its factory could not build" `Quick
              registry_construct_failed;
            Alcotest.test_case "an activation after the registry closed" `Quick
              registry_closed_activation;
          ] );
    ]
