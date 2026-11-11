open Eio.Std
open Semiont
module J = Yojson.Safe.Util

let option decode value =
  match value with `Null -> None | value -> Some (decode value)

let check condition reason = Alcotest.(check bool) reason true condition
let row_name row = J.member "why" row |> J.to_string

(* All four policies and the header table in retry/cases.json. *)
let retry_rules () =
  Yojson.Safe.from_string Retry_cases.rules
  |> J.to_list
  |> List.iter (fun row ->
      let field key = J.member key row in
      let rule =
        match J.to_string (field "rule") with
        | "boot" -> Retry.Boot
        | "job" -> Job
        | "transport" -> Transport
        | "refresh" -> Refresh
        | _ -> assert false
      in
      let actual =
        Retry.retryable rule
          ?status:(option J.to_int (field "status"))
          ?meth:(option J.to_string (field "method"))
          ?keyed:(option J.to_bool (field "keyed"))
          ()
      in
      Alcotest.(check bool) (row_name row) (J.to_bool (field "retries")) actual);
  Yojson.Safe.from_string Retry_cases.retry_after
  |> J.to_list
  |> List.iter (fun row ->
      let actual =
        Option.bind
          (option J.to_string (J.member "header" row))
          Retry.retry_after_ms
      in
      Alcotest.(check (option int))
        (row_name row)
        (option J.to_int (J.member "ms" row))
        actual)

let mock_clock () =
  let mono = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 12 |])
    |> fun clock -> Clock.with_jitter clock (fun () -> 0.)
  in
  (clock, mono, wall)

let advance mono milliseconds =
  Eio_mock.Clock.Mono.set_time mono
    (Mtime.add_span (Eio.Time.Mono.now mono) Mtime.Span.(milliseconds * ms)
    |> Option.get)

let settle () =
  for _ = 1 to 16 do
    Fiber.yield ()
  done

let retry_timing () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let clock, mono, _ = mock_clock () in
  let calls = ref 0 in
  let result =
    Fiber.fork_promise ~sw (fun () ->
        Retry.retry_with_backoff ~clock
          ~budget:{ attempts = 3; initial_delay_ms = 100; max_delay_ms = 200 }
          ~accepts:(fun _ -> true)
          ~retry_after:(fun _ -> Some 80)
          (fun () ->
            incr calls;
            if !calls < 3 then Error "try again" else Ok "settled"))
  in
  settle ();
  check (!calls = 1) "first attempt runs immediately";
  advance mono 79;
  settle ();
  check (!calls = 1) "Retry-After floors equal jitter";
  advance mono 1;
  settle ();
  check (!calls = 2) "second attempt at the floor";
  advance mono 99;
  settle ();
  check (!calls = 2) "second jittered delay has not elapsed";
  advance mono 1;
  settle ();
  check (Promise.await_exn result = Ok "settled") "third attempt succeeds"

let persistence () =
  Eio_mock.Backend.run @@ fun () ->
  let clock, _, _ = mock_clock () in
  let shared = Testing.shared_storage () in
  let first = Testing.storage_context shared
  and second = Testing.storage_context shared in
  let make ?(version = 1) ?(max_bytes = 4096) storage =
    Storage_persister.make ~storage ~key:"cache" ~version ~max_bytes ~clock
  in
  let writer = make first and reader = make second in
  let one = ("resource", Some "res-1", None)
  and two = ("annotations", Some "res-1", None) in
  let notices = ref [] in
  let stop =
    Storage.subscribe second "cache" (fun value -> notices := value :: !notices)
    |> Option.get
  in
  Storage_persister.save_batch writer
    ~positions:[ ("res-1", "1-0") ]
    [ (one, Some (`String "ready")) ];
  Storage_persister.save reader two (Some (`List []));
  check
    (Storage_persister.restore reader one = Some (`String "ready"))
    "value restored across contexts";
  check
    (Storage_persister.restore writer two = Some (`List []))
    "second writer retains the first entry";
  check
    (Storage_persister.positions reader = [ ("res-1", "1-0") ])
    "positions restored with cache";
  check
    (List.length !notices = 1)
    "other contexts observe an atomic update once";
  check
    (Storage_persister.restore (make ~version:2 second) one = None)
    "wrong version ignored";
  Storage_persister.save writer one None;
  check (Storage_persister.restore reader one = None) "removal is durable";
  stop ();
  Storage.set first "cache" {|{"version":1,"entries":[null]}|};
  check
    (Storage_persister.positions reader = [])
    "malformed document is ignored as a whole";
  Storage_persister.save (make ~max_bytes:1 first) one (Some (`String "large"));
  check
    (Storage.get second "cache" = None)
    "document respects byte cap even when empty"

let issuer_response =
  {|{"issuer":"https://issuer.example","authorization_endpoint":"https://issuer.example/auth","token_endpoint":"https://issuer.example/token"}|}

let service () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let clock, mono, _ = mock_clock () in
  let discoveries = ref 0 and grants = ref 0 in
  let refuse = ref false and lifetime = ref true in
  let http (request : OAuth.request) =
    match request.meth with
    | "GET" ->
        incr discoveries;
        (200, issuer_response)
    | "POST" ->
        incr grants;
        check
          (request.url = "https://issuer.example/token")
          "grant stays at the issuer";
        check
          (List.assoc "client_secret" request.form = "secret")
          "secret grant carries proof";
        Fiber.yield ();
        if !refuse then (400, {|{"error":"invalid_client"}|})
        else
          ( 200,
            Printf.sprintf {|{"access_token":"token-%d"%s}|} !grants
              (if !lifetime then {|,"expires_in":3600|} else "") )
    | _ -> assert false
  in
  let service =
    Service_token.make ~clock ~http ~authority:"https://issuer.example"
      ~client_id:"service" ~proof:(Service_token.Secret "secret")
      ~jti:(fun () -> "id")
      ()
  in
  check (!discoveries = 0) "discovery is lazy";
  let requests =
    List.init 8 (fun _ ->
        Fiber.fork_promise ~sw (fun () -> Service_token.token service))
  in
  List.iter
    (fun request ->
      check
        (Promise.await_exn request = Ok "token-1")
        "concurrent callers share one grant")
    requests;
  check (!discoveries = 1 && !grants = 1) "one discovery and one grant";
  check
    (Service_token.authorization service = Ok "Bearer token-1")
    "authorization value";
  advance mono 3299000;
  check
    (Service_token.token service = Ok "token-1")
    "still cached before deadline";
  advance mono 1000;
  check
    (Service_token.token service = Ok "token-2")
    "refresh at monotonic deadline";
  refuse := true;
  check
    (Result.is_error (Service_token.renew service ~refused:"token-2"))
    "issuer refusal returned";
  refuse := false;
  check
    (Service_token.token service = Ok "token-4" && !discoveries = 1)
    "failed renewal evicts token and keeps discovery";
  lifetime := false;
  check
    (Service_token.renew service ~refused:"token-4" = Ok "token-5")
    "forced renewal";
  check
    (Service_token.token service = Ok "token-6")
    "grant without lifetime is not cached";
  Service_token.dispose service;
  check
    (Result.is_error (Service_token.token service))
    "disposed token cannot acquire"

let redirect () =
  Eio_mock.Backend.run @@ fun () ->
  let module R = Redirect_sign_in in
  check
    (R.code_challenge "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
    "RFC 7636 S256 vector";
  let exchanges = ref 0 in
  let http (request : OAuth.request) =
    if request.meth = "GET" then (200, issuer_response)
    else (
      incr exchanges;
      check
        (List.assoc "code_verifier" request.form <> "")
        "restored verifier exchanged";
      (200, {|{"access_token":"access","refresh_token":"refresh"}|}))
  in
  let issuer =
    OAuth.discover http ~issuer:"https://issuer.example" |> Result.get_ok
  in
  let pending =
    R.begin_authorization
      {
        issuer;
        random = (fun length -> String.make length 'A');
        redirect_uri = "http://localhost/callback";
        target =
          Models.decode Models.http_endpoint
            {|{"kind":"http","host":"localhost","port":4010,"protocol":"http"}|}
          |> Result.get_ok;
        kb_id = Some "kb";
        expected_did = Some "did:web:kb.example";
        expected_name = None;
      }
  in
  let state =
    Uri.get_query_param (Uri.of_string (R.url pending)) "state" |> Option.get
  in
  let shared = Testing.shared_storage () in
  let a = Testing.storage_context shared
  and b = Testing.storage_context shared in
  R.keep a pending;
  let restored = R.take b |> Option.get in
  check
    (restored.kb_id = Some "kb"
    && restored.expected_did = Some "did:web:kb.example")
    "shared pending fields round trip";
  check (R.take a = None) "pending record taken once across contexts";
  check
    (Result.is_error
       (R.complete_authorization http restored
          ~callback:
            ("http://localhost/callback?state=" ^ state ^ "&state=" ^ state
           ^ "&code=one")))
    "ambiguous state refused before exchange";
  check (!exchanges = 0) "rejected callback did not spend its code";
  let callback = "http://localhost/callback?state=" ^ state ^ "&code=one" in
  check
    (Result.is_ok (R.complete_authorization http restored ~callback))
    "restored callback completes";
  check (!exchanges = 1) "issuer rediscovery not required"

let testing () =
  Eio_main.run @@ fun env ->
  let clock =
    Clock.make
      ~monotonic:(Eio.Stdenv.mono_clock env)
      ~wall:(Eio.Stdenv.clock env)
      ~jitter:(Random.State.make [| 2 |])
  in
  let setup schedule run =
    Switch.run @@ fun sw ->
    let transport =
      Testing.transport ~sw ~clock ~schedule ~respond:(fun ~channel:_ _ ->
          Some
            ( "browse:entity-types-result",
              `Assoc [ ("response", `Assoc [ ("entityTypes", `List []) ]) ] ))
    in
    let session =
      Session.start ~sw ~clock ~initial_token:(Some "token")
        ~renew:(fun ~holding:_ -> Session.Refused)
        ()
    in
    let serial = ref 0 in
    let client =
      Client.connect ~sw ~clock ~session ~client_id:"testing"
        ~key:(fun () ->
          incr serial;
          string_of_int !serial)
        ~call:(Testing.call transport) ~global:Bus_registry.bridged_channels
        ~on_event:ignore ~on_error:ignore ()
    in
    let outcome, resolve = Promise.create () in
    let request () =
      let result =
        try
          Client.request client ~timeout_ms:20
            Bus_registry.Operations.browse_entity_types_requested "{}"
        with Http_wire.Failed _ -> Error Subscription.Timeout
      in
      Promise.resolve resolve result
    in
    let output () =
      match Promise.await outcome with
      | Ok (Subscription.Result _) | Error Subscription.Timeout -> ()
      | _ -> failwith "unexpected scripted response"
    in
    Fun.protect
      ~finally:(fun () ->
        Client.close client;
        Client.await_closed client;
        Session.close session)
      (fun () ->
        run
          {
            Testing.outputs = [ output ];
            settlements = [ request ];
            requests = (fun () -> Testing.request_log transport);
          })
  in
  Testing.assert_liveness_axioms
    {
      clock;
      timeout_ms = 30;
      retry_budget = 2;
      schedules =
        [
          [ Deliver ];
          [ Drop_reply ];
          [ Delay 2 ];
          [ Duplicate_reply ];
          [ Reject_emit ];
        ];
      setup;
    };
  let broken =
    try
      Testing.assert_liveness_axioms
        {
          clock;
          timeout_ms = 1;
          retry_budget = 0;
          schedules = [ [ Drop_reply ] ];
          setup =
            (fun _ run ->
              run
                {
                  outputs = [ Fiber.await_cancel ];
                  settlements = [];
                  requests = (fun () -> []);
                });
        };
      false
    with Failure _ -> true
  in
  check broken "silent output violates L1";
  let random = Random.State.make [| 9 |] in
  for _ = 1 to 20 do
    let operations = Testing.delivery_ops random ~max_length:8 in
    check
      (List.length operations <= 8 && List.mem Testing.Write operations)
      "generated delivery schedule";
    let schedule = Testing.fault_schedules random in
    check
      (schedule <> [] && List.length schedule <= 8)
      "generated fault schedule"
  done;
  let setup ~duplicate run =
    let events = ref [] in
    run
      {
        Testing.write =
          (fun id ->
            events := !events @ if duplicate then [ id; id ] else [ id ]);
        transition = ignore;
        delivered = (fun () -> !events);
      }
  in
  Testing.assert_exactly_once_delivery
    [ Write; Transition; Write ]
    (setup ~duplicate:false);
  let duplicate =
    try
      Testing.assert_exactly_once_delivery
        [ Write; Transition; Write ]
        (setup ~duplicate:true);
      false
    with Failure _ -> true
  in
  check duplicate "duplicate output violates L3"

let real_delivery () =
  Eio_main.run @@ fun env ->
  Switch.run @@ fun sw ->
  let clock =
    Clock.make
      ~monotonic:(Eio.Stdenv.mono_clock env)
      ~wall:(Eio.Stdenv.clock env)
      ~jitter:(Random.State.make [| 2 |])
  in
  let transport =
    Testing.transport ~sw ~clock ~schedule:[] ~respond:(fun ~channel:_ _ ->
        None)
  in
  let shared = Testing.shared_storage () in
  let storage = Testing.storage_context shared in
  let persister =
    Storage_persister.make ~storage ~key:"client" ~version:1 ~max_bytes:4096
      ~clock
  in
  let query_key = ("entityTypes", None, None) in
  Storage_persister.save persister query_key
    (Some (`Assoc [ ("entityTypes", `List [ `String "Person" ]) ]));
  let scripted = Testing.scripted_sessions () in
  Testing.queue_renewal scripted (Session.Renewed "second");
  let session =
    Session.start ~sw ~clock ~initial_token:(Some "initial")
      ~renew:(Testing.renew scripted) ()
  in
  let seen = ref [] in
  let events = Eio.Stream.create 32 in
  let serial = ref 0 in
  let on_event = function
    | Ok (Wire_stream.Frame { id = Some id; route; _ })
      when route.channel = "beckon:focus" ->
        seen := !seen @ [ id ];
        Eio.Stream.add events id
    | _ -> ()
  in
  let content ~meth:_ ~path ~headers:_ ~body:_ =
    if path <> "/api/users/me" then (404, [], Eio.Flow.string_source "{}")
    else
      ( 200,
        [],
        Eio.Flow.string_source
          {|{"did":"did:web:kb.example:users:tester","email":null,"name":"Tester","image":null,"domain":"kb.example"}|}
      )
  in
  let client =
    Client.connect ~sw ~clock ~session ~client_id:"test" ~persister
      ~timing:
        {
          Subscription.default_timing with
          reconnect_ms = 1;
          max_reconnect_ms = 1;
        }
      ~key:(fun () ->
        incr serial;
        string_of_int !serial)
      ~call:(Testing.call ~content transport)
      ~global:Bus_registry.bridged_channels ~on_event ~on_error:ignore ()
  in
  let kb =
    Models.decode Models.knowledge_base
      {|{"id":"kb","label":"Test","did":"did:web:kb.example","endpoint":{"kind":"http","host":"localhost","port":4010,"protocol":"http"}}|}
    |> Result.get_ok
  in
  Testing.queue_session scripted "kb" (fun _ ->
      let description =
        Models.decode Models.kb_description
          {|{"name":"Test","domain":"kb.example"}|}
        |> Result.get_ok
      in
      Ok (client, { Registry.did = "did:web:kb.example"; description }));
  let factory = Testing.factory scripted in
  let registry_storage : Registry.storage =
    {
      read = Storage.get storage;
      write = Storage.set storage;
      remove = Storage.delete storage;
    }
  in
  check
    (Result.is_ok (factory { kb; storage = registry_storage; signals = None }))
    "scripted factory builds a session";
  check
    (Result.is_error
       (factory { kb; storage = registry_storage; signals = None }))
    "unscripted factory input fails";
  let test = Testing.create_test_session { client; kb; id = "kb" } in
  let bus = Client.subscription client in
  let rec await_open () =
    match Subscription.state bus with
    | Open -> ()
    | Closed -> failwith "test bus closed"
    | from ->
        ignore (Subscription.await_state_change bus ~from);
        await_open ()
  in
  let checked_run () =
    State_units.Session.ready test.session;
    check
      (Option.is_some (State_value.get (State_units.Session.user test.session)))
      "test session confirms identity";
    check
      (State_units.Session.refresh test.session ~refused:"initial" ()
      = Some "second")
      "scripted renewal";
    let restored = ref None in
    let release =
      Client.observe
        (Client.query client query_key)
        ~on_state:(fun state -> if !restored = None then restored := Some state)
        ~on_close:ignore
    in
    check
      (!restored
      = Some
          (Live_query.Ready
             (`Assoc [ ("entityTypes", `List [ `String "Person" ]) ])))
      "public query starts with persisted value";
    release ();
    await_open ();
    let send id =
      Testing.deliver transport ~id "beckon:focus"
        (`Assoc
           [
             ("resourceId", `String "res-1"); ("annotationId", `String "ann-1");
           ])
    in
    Testing.assert_exactly_once_delivery [ Write; Transition; Write ]
      (fun run ->
        run
          {
            write =
              (fun id ->
                send id;
                check (Eio.Stream.take events = id) "received expected frame");
            transition =
              (fun () ->
                Testing.disconnect transport;
                ignore (Subscription.await_state_change bus ~from:Open);
                await_open ();
                List.iter send !seen);
            delivered = (fun () -> !seen);
          })
  in
  Fun.protect
    ~finally:(fun () ->
      test.close ();
      Client.close client;
      Client.await_closed client)
    (fun () -> Eio.Time.with_timeout_exn (Eio.Stdenv.clock env) 2. checked_run)

let test_annotation =
  Yojson.Safe.from_string
    {|{"@context":"http://www.w3.org/ns/anno.jsonld","type":"Annotation","id":"ann-1","motivation":"highlighting","target":"res-1","created":"2026-01-01T00:00:00Z"}|}

(* A positioned event on res-1 that carries [annotation], checked against its
   channel's schema. *)
let annotation_event channel ~sequence ~payload annotation =
  let event =
    `Assoc
      [
        ("id", `String ("event-" ^ string_of_int sequence));
        ("type", `String (Bus_registry.name channel));
        ("timestamp", `String "2026-01-01T00:00:00Z");
        ("userId", `String "did:web:kb.example:users:tester");
        ("resourceId", `String "res-1");
        ("version", `Int 1);
        ("metadata", `Assoc [ ("sequenceNumber", `Int sequence) ]);
        ( "agent",
          `Assoc
            [
              ("@type", `String "Person");
              ("@id", `String "did:web:kb.example:users:tester");
            ] );
        ("payload", payload);
        ("annotation", annotation);
      ]
  in
  check
    (Result.is_ok
       (Bus_registry.decode_received channel (Yojson.Safe.to_string event)))
    "positioned test event is valid";
  event

let annotations_body listed =
  Eio.Flow.string_source
    (Yojson.Safe.to_string (`Assoc [ ("annotations", `List listed) ]))

let kept_client ~sw ~clock ~store ~content ~global =
  let transport =
    Testing.transport ~sw ~clock ~schedule:[] ~respond:(fun ~channel:_ _ ->
        None)
  in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some "test")
      ~renew:(fun ~holding:_ -> Session.Refused)
      ()
  in
  let client =
    Client.connect ~sw ~clock ~session ~client_id:"test"
      ~key:(fun () -> "key")
      ~call:(Testing.call ~content transport)
      ~persister:store
      ~global:(Bus_registry.bridged_channels @ global)
      ~on_event:ignore ~on_error:ignore ()
  in
  (transport, session, client)

let replay_persistence () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let clock, mono, _ = mock_clock () in
  let storage = Testing.shared_storage () |> Testing.storage_context in
  let store =
    Storage_persister.make ~storage ~key:"cache" ~version:1 ~max_bytes:8192
      ~clock
  in
  let annotations = ref [] in
  let asks = ref 0 in
  let answered, answer = Promise.create () in
  let content ~meth:_ ~path ~headers:_ ~body:_ =
    match path with
    | "/resources/res-1/annotations" ->
        incr asks;
        (* The first ask is answered at once; the event's refetch waits for
           the test. *)
        if !asks > 1 then Promise.await answered;
        (200, [], annotations_body !annotations)
    | "/resources/res-2/annotations" -> (200, [], annotations_body [])
    | _ -> Alcotest.fail ("fetches an unexpected path " ^ path)
  in
  let transport, session, client =
    kept_client ~sw ~clock ~store ~content
      ~global:[ Bus_registry.Channel Bus_registry.Channels.mark_added ]
  in
  let id = Identifiers.Resource_id.of_string "res-1" |> Result.get_ok in
  let other = Identifiers.Resource_id.of_string "res-2" |> Result.get_ok in
  let query = Client.Browse.annotations client id in
  let release = Client.observe query ~on_state:ignore ~on_close:ignore in
  Fun.protect
    ~finally:(fun () ->
      release ();
      Client.close client;
      Client.await_closed client;
      Session.close session)
    (fun () ->
      settle ();
      advance mono 50;
      settle ();
      let key = ("annotations", Some "res-1", None) in
      check
        (Storage_persister.restore store key = Some (`List []))
        "initial cache saved";
      let annotation = test_annotation in
      let payload =
        annotation_event Bus_registry.Channels.mark_added ~sequence:1
          ~payload:(`Assoc [ ("annotation", annotation) ])
          annotation
      in
      annotations := [ annotation ];
      Testing.deliver transport ~id:"res-1-1" ~scope:"res-1" "mark:added"
        payload;
      settle ();
      check
        (Client.fresh (Client.Browse.annotations client other) = Ok (`List []))
        "another kept query is read while the refetch is in flight";
      advance mono 50;
      settle ();
      check
        (Storage_persister.restore store ("annotations", Some "res-2", None)
        = Some (`List []))
        "a kept query saved while the refetch was in flight";
      check
        (Storage_persister.positions store = [])
        "a save during the event's refetch wrote its place";
      let refetched = Fiber.fork_promise ~sw (fun () -> Client.fresh query) in
      Promise.resolve answer ();
      check
        (Promise.await_exn refetched = Ok (`List [ annotation ]))
        "the refetch's value is seen through fresh";
      advance mono 50;
      settle ();
      check
        (Storage_persister.restore store key = Some (`List [ annotation ]))
        "event value persisted";
      check
        (Storage_persister.positions store = [ ("res-1", "res-1-1") ])
        "position and value committed together")

(* A place is noted only once its event's handlers have taken it: a handler
   that yields lets the debounced save run between them. *)
let place_after_handlers () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let clock, mono, _ = mock_clock () in
  let storage = Testing.shared_storage () |> Testing.storage_context in
  let store =
    Storage_persister.make ~storage ~key:"cache" ~version:1 ~max_bytes:8192
      ~clock
  in
  let annotation = test_annotation in
  let updated =
    `Assoc
      (J.to_assoc annotation @ [ ("modified", `String "2026-01-02T00:00:00Z") ])
  in
  let content ~meth:_ ~path ~headers:_ ~body:_ =
    check (path = "/resources/res-1/annotations") "fetches annotation list";
    (200, [], annotations_body [ annotation ])
  in
  let transport, session, client =
    kept_client ~sw ~clock ~store ~content
      ~global:[ Bus_registry.Channel Bus_registry.Channels.mark_body_updated ]
  in
  let suspended, suspend = Promise.create () in
  let resumed, resume = Promise.create () in
  let id = Identifiers.Resource_id.of_string "res-1" |> Result.get_ok in
  let release =
    Client.observe
      (Client.Browse.annotations client id)
      ~on_state:(function
        | Live_query.Ready (`List [ value ]) when value = updated ->
            Promise.resolve suspend ();
            Promise.await resumed
        | _ -> ())
      ~on_close:ignore
  in
  Fun.protect
    ~finally:(fun () ->
      release ();
      Client.close client;
      Client.await_closed client;
      Session.close session)
    (fun () ->
      settle ();
      let payload =
        annotation_event Bus_registry.Channels.mark_body_updated ~sequence:2
          ~payload:
            (`Assoc
               [ ("annotationId", `String "ann-1"); ("operations", `List []) ])
          updated
      in
      Testing.deliver transport ~id:"res-1-2" ~scope:"res-1" "mark:body-updated"
        payload;
      Promise.await suspended;
      advance mono 50;
      settle ();
      check
        (Storage_persister.restore store ("annotations", Some "res-1", None)
        = Some (`List [ updated ]))
        "the event's write was saved while its handler waited";
      check
        (Storage_persister.positions store = [])
        "a save while the event's handlers ran wrote its place";
      Promise.resolve resume ();
      settle ();
      check
        (Subscription.positions (Client.subscription client)
        = [ ("res-1", "res-1-2") ])
        "the place was not noted once the handlers had run")

(* CACHE-SEMANTICS B20: a key that holds a value is refreshed whether or not
   anyone observes it. *)
let unobserved_refresh () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let clock, _, _ = mock_clock () in
  let loads = ref 0 in
  let query =
    Live_query.make ~sw ~clock
      ~load:(fun _ ->
        incr loads;
        Ok (`Int !loads))
      ~hold:(fun _ () -> ())
      ()
  in
  let key = ("annotations", Some "res-1", None) in
  Fun.protect
    ~finally:(fun () -> Live_query.close query)
    (fun () ->
      check (Live_query.fresh query key = Ok (`Int 1)) "the key is read once";
      Live_query.refetch query ~on:"mark:added"
        ~payload:(Some (`Assoc [ ("resourceId", `String "res-1") ]));
      settle ();
      check
        (Live_query.get query key = Some (`Int 2))
        "an event left stale a value no one observes")

(* CACHE-SEMANTICS B17: a place waits for every kept key, not only the keys of
   its own scope. *)
let replay_waits_for_every_key () =
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let clock, _, _ = mock_clock () in
  let answered, answer = Promise.create () in
  let listed : Yojson.Safe.t = `List [] in
  let query =
    Live_query.make ~sw ~clock
      ~load:(fun (_, resource, _) ->
        if resource = Some "res-2" then Promise.await answered;
        Ok listed)
      ~hold:(fun _ () -> ())
      ()
  in
  let own = ("annotations", Some "res-1", None) in
  let other = ("annotations", Some "res-2", None) in
  let changes = [ (own, Some listed) ] in
  Fun.protect
    ~finally:(fun () -> Live_query.close query)
    (fun () ->
      check (Live_query.fresh query own = Ok listed) "the scope's key is read";
      let read =
        Fiber.fork_promise ~sw (fun () -> Live_query.fresh query other)
      in
      settle ();
      check
        (not (Live_query.ready_for_replay query "res-1" changes))
        "a place was ready while another scope's key was fetching";
      Promise.resolve answer ();
      check (Promise.await_exn read = Ok listed) "the other key is read";
      check
        (Live_query.ready_for_replay query "res-1" changes)
        "a place stayed held back once every key had settled")

let observe_during_invalidation () =
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun sw ->
  let clock, _, _ = mock_clock () in
  let reply, send_reply = Promise.create () in
  let ready, mark_ready = Promise.create () in
  let requests = ref 0 in
  let query =
    Live_query.make ~sw ~clock
      ~load:(fun () ->
        incr requests;
        Ok (Promise.await reply))
      ~hold:(fun () () -> ())
      ()
  in
  Live_query.invalidate query ();
  let release =
    Live_query.observe query ()
      ~on_state:(function
        | Pending ->
            Promise.resolve send_reply "value";
            Promise.await ready
        | Ready _ -> Promise.resolve mark_ready ()
        | Failed reason -> Alcotest.fail reason)
      ~on_close:ignore
  in
  let duplicate = !requests > 1 || Live_query.in_flight query in
  release ();
  Live_query.close query;
  Alcotest.(check bool) "observer started another fetch" false duplicate

let () =
  Alcotest.run "OCaml completion"
    [
      ( "shared retry",
        [
          Alcotest.test_case "retry rules and headers" `Quick retry_rules;
          Alcotest.test_case "equal jitter and retry-after" `Quick retry_timing;
        ] );
      ( "persistence",
        [
          Alcotest.test_case "observe during invalidation" `Quick
            observe_during_invalidation;
          Alcotest.test_case "atomic cache documents" `Quick persistence;
          Alcotest.test_case "cache and replay position are co-written" `Quick
            replay_persistence;
          Alcotest.test_case "a place is noted once its handlers ran" `Quick
            place_after_handlers;
          Alcotest.test_case "an event refreshes an unobserved value" `Quick
            unobserved_refresh;
          Alcotest.test_case "a place waits for every kept key" `Quick
            replay_waits_for_every_key;
        ] );
      ( "authorization",
        [
          Alcotest.test_case "service grants and expiry" `Quick service;
          Alcotest.test_case "durable redirect" `Quick redirect;
        ] );
      ( "consumer testing",
        [
          Alcotest.test_case "liveness and negative controls" `Quick testing;
          Alcotest.test_case "real client reconnect and persisted query" `Quick
            real_delivery;
        ] );
    ]
