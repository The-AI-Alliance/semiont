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
            Client.connect ~subscribe_defaults:false ~sw ~clock ~session
              ~client_id:"clock-test"
              ~key:(fun () -> "clock-key")
              ~call ~global:[] ~on_event:ignore ~on_error:ignore ()
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
      | ("heldJobStall" | "invalidationWindow" | "jobFollower") as subject -> (
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
                  incr count;
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
              ~call ~global:[] ~on_event:ignore ~on_error:ignore ()
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
          | _ ->
              let filter =
                Result.get_ok
                  (Models.decode Models.job_filter
                     {|{"jobType":"mark","params":{"motivation":"highlighting"}}|})
              in
              let claims =
                Client.Job.claim client
                  ~on_stalled:(fun _ -> incr count)
                  [ filter ]
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
              ~call ~global:[] ~on_event:ignore ~on_error:ignore ()
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
        on_error = ignore;
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
  let sign port domain access =
    Result.get_ok
      (R.record_sign_in browser
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
         })
  in
  let id (outcome : R.sign_in_outcome) =
    (Records.Knowledge_base.of_model outcome.kb).id
  in
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
      on_error = ignore;
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
        (200, {|{"access_token":"access","refresh_token":"refresh"}|})
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
  assert (complete (callback ^ "bad") = Error "oauth.invalid-redirect");
  assert (complete callback = Error "oauth.invalid-redirect");
  assert (!exchanges = 0);
  ignore (begin_ ());
  let outcome = Result.get_ok (complete callback) in
  assert ((Option.get outcome.expected).did = "did:web:expected.example");
  assert ((Records.Knowledge_base.of_model outcome.kb).id = "kb-redirect");
  let kept = Option.get ((R.kept_in storage "kb-redirect").held ()) in
  assert (kept.access = "access" && kept.refresh = "refresh");
  assert (kept.revocation_endpoint = Some "https://issuer.example/revoke");
  assert (complete callback = Error "oauth.invalid-redirect");
  assert (!discovery = 2 && !exchanges = 1 && !takes = 4)

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
        on_error = ignore;
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
      ~call ~global:[] ~on_event:ignore ~on_error:ignore ()
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

let () =
  Alcotest.run "OCaml registry and discovery"
    [
      ( "registry",
        [
          Alcotest.test_case "shared cases" `Quick shared;
          Alcotest.test_case "shared gateway origins" `Quick gateway_urls;
          Alcotest.test_case "verified sign-in" `Quick sign_in;
          Alcotest.test_case "durable redirect and replay" `Quick redirect;
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
    ]
