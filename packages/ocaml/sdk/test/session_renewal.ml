open Eio.Std
module Session = Semiont.Session

let token claims =
  "header."
  ^ Base64.encode_exn ~pad:false ~alphabet:Base64.uri_safe_alphabet claims
  ^ ".signature"

let settle () =
  for _ = 1 to 24 do
    Fiber.yield ()
  done

(* The generated data comes from session/cases.json. *)
let table () =
  let open Yojson.Safe.Util in
  let cases = Yojson.Safe.from_string Session_cases.cases in
  let expected case field = case |> member field |> to_option to_number in
  List.iter
    (fun case ->
      let jwt =
        match member "token" case with
        | `String literal -> literal
        | _ -> token (Yojson.Safe.to_string (member "claims" case))
      in
      Alcotest.(check (option (float 0.)))
        (case |> member "why" |> to_string)
        (expected case "delay")
        (Session.refresh_delay ~now:(case |> member "now" |> to_number) jwt))
    (cases |> member "refreshSchedule" |> to_list);
  List.iter
    (fun case ->
      Alcotest.(check (option (float 0.)))
        (case |> member "why" |> to_string)
        (expected case "exp")
        (case |> member "token" |> to_string |> Session.token_expiry))
    (cases |> member "tokenExpiry" |> to_list)

let proactive () =
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun sw ->
  let base = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let armed, arm = Promise.create () in
  let module Timer = struct
    type t = unit
    type time = Mtime.t

    let now () = Eio.Time.Mono.now base

    let sleep_until () due =
      if not (Promise.is_resolved armed) then Promise.resolve arm due;
      Eio.Time.Mono.sleep_until base due
  end in
  let monotonic = Eio.Resource.T ((), Eio.Time.Pi.clock (module Timer)) in
  let clock =
    Semiont.Clock.make ~monotonic ~wall ~jitter:(Random.State.make [| 1 |])
  in
  let initial = token {|{"iat":0,"exp":15}|} in
  let entered, enter = Promise.create () in
  let release, finish = Promise.create () in
  let calls = ref 0 in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some initial)
      ~renew:(fun ~holding ->
        incr calls;
        Alcotest.(check (option string))
          "a scheduled renewal is handed the token it renews" (Some initial)
          holding;
        Promise.resolve enter ();
        Promise.await release;
        Session.Renewed "replacement")
      ()
  in
  let due = Promise.await armed in
  let before = Mtime.of_uint64_ns (Int64.pred (Mtime.to_uint64_ns due)) in
  let barrier =
    Fiber.fork_promise ~sw (fun () -> Eio.Time.Mono.sleep_until base before)
  in
  Eio_mock.Clock.Mono.set_time base before;
  Promise.await_exn barrier;
  Alcotest.(check int) "no renewal before deadline" 0 !calls;
  Eio_mock.Clock.Mono.set_time base due;
  Promise.await entered;
  let refused =
    Fiber.fork_promise ~sw (fun () ->
        Session.refresh_refused session ~refused:initial)
  in
  Promise.resolve finish ();
  Alcotest.(check (option string))
    "refusal joins in-flight renewal" (Some "replacement")
    (Promise.await_exn refused);
  Alcotest.(check int) "one issuer call" 1 !calls;
  Session.close session;
  Session.await_closed session

let backoff () =
  let open Semiont in
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
    |> fun clock -> Clock.with_jitter clock (fun () -> 0.)
  in
  let refused = token {|{"iat":0,"exp":3600}|} in
  let handed = ref [] in
  let answers = ref [ Session.Unavailable; Session.Renewed "replacement" ] in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some refused)
      ~renew:(fun ~holding ->
        handed := holding :: !handed;
        match !answers with
        | answer :: rest ->
            answers := rest;
            answer
        | [] -> Alcotest.fail "renewed again after a renewal was made")
      ()
  in
  Session.manage session (fun ~current:_ ~refused:_ outcome -> outcome);
  Alcotest.(check (option string))
    "a renewal that got no answer gives no token" None
    (Session.refresh_refused session ~refused);
  settle ();
  Eio_mock.Clock.Mono.set_time mono
    (Option.get
       (Mtime.add_span (Clock.monotonic_now clock) Mtime.Span.(6000 * ms)));
  settle ();
  Alcotest.(check (list (option string)))
    "the refusal's renewal and the backoff's are each handed the refused token"
    [ Some refused; Some refused ]
    (List.rev !handed);
  Alcotest.(check (option string))
    "the backoff renews it" (Some "replacement")
    (Session.credential session);
  Session.close session;
  Session.await_closed session

(* The wait runs out and the refusal's renewal is let go with no yield between,
   so the session's timer runs before the renewal publishes its token, and the
   schedule only after it. *)
let replaced_before_due () =
  let open Semiont in
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
  in
  let initial = token {|{"iat":0,"exp":3600}|} in
  let release, finish = Promise.create () in
  let handed = ref [] in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some initial)
      ~renew:(fun ~holding ->
        handed := holding :: !handed;
        Promise.await release;
        Session.Renewed "replacement")
      ()
  in
  let refused =
    Fiber.fork_promise ~sw (fun () ->
        Session.refresh_refused session ~refused:initial)
  in
  settle ();
  Eio_mock.Clock.Mono.set_time mono
    (Option.get
       (Mtime.add_span (Clock.monotonic_now clock) Mtime.Span.(3600 * s)));
  Promise.resolve finish ();
  Alcotest.(check (option string))
    "the refusal is given the renewed token" (Some "replacement")
    (Promise.await_exn refused);
  settle ();
  Alcotest.(check (list (option string)))
    "the wait for the replaced token renews nothing" [ Some initial ]
    (List.rev !handed);
  Session.close session;
  Session.await_closed session

let replaced_before_backoff () =
  let open Semiont in
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
    |> fun clock -> Clock.with_jitter clock (fun () -> 0.)
  in
  let advance span =
    Eio_mock.Clock.Mono.set_time mono
      (Option.get (Mtime.add_span (Clock.monotonic_now clock) span))
  in
  let initial = token {|{"iat":0,"exp":3600}|} in
  let release, finish = Promise.create () in
  let handed = ref [] in
  let session =
    Session.start ~keep_on_unavailable:true ~sw ~clock
      ~initial_token:(Some initial)
      ~renew:(fun ~holding ->
        handed := holding :: !handed;
        match !handed with
        | [ _ ] -> Session.Unavailable
        | _ ->
            Promise.await release;
            Session.Renewed "replacement")
      ()
  in
  advance Mtime.Span.(3600 * s);
  settle ();
  let refused =
    Fiber.fork_promise ~sw (fun () ->
        Session.refresh_refused session ~refused:initial)
  in
  settle ();
  advance Mtime.Span.(6000 * ms);
  Promise.resolve finish ();
  Alcotest.(check (option string))
    "the refusal is given the renewed token" (Some "replacement")
    (Promise.await_exn refused);
  settle ();
  Alcotest.(check (list (option string)))
    "the backoff for the replaced token renews nothing"
    [ Some initial; Some initial ]
    (List.rev !handed);
  Session.close session;
  Session.await_closed session

(* The renewal's answer is let go and the session closed with no yield between,
   so the renewal takes its answer up only once the session is closed. *)
let closed_before_answer_taken () =
  let open Semiont in
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
  in
  let initial = token {|{"iat":0,"exp":3600}|} in
  let release, finish = Promise.create () in
  let asked = ref 0 in
  let judged = ref 0 in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some initial)
      ~renew:(fun ~holding:_ ->
        incr asked;
        Promise.await release;
        Session.Renewed "late")
      ()
  in
  Session.manage session (fun ~current:_ ~refused:_ outcome ->
      incr judged;
      outcome);
  let refused =
    Fiber.fork_promise ~sw (fun () ->
        Session.refresh_refused session ~refused:initial)
  in
  settle ();
  Promise.resolve finish ();
  Session.close session;
  Alcotest.(check (option string))
    "the refusal waiting on the renewal the close ended is given no token" None
    (Promise.await_exn refused);
  Session.await_closed session;
  Alcotest.(check int)
    "what the renewal brings back once the session is closed ends nothing" 0
    !judged;
  Alcotest.(check (option string))
    "the token the renewal brings back is not taken" None
    (Session.credential session);
  Alcotest.(check (option string))
    "a refusal once the session is closed is given no token" None
    (Session.refresh_refused session ~refused:initial);
  Alcotest.(check (option string))
    "a refusal of a token already replaced is given no token" None
    (Session.refresh_refused session ~refused:"replaced");
  Alcotest.(check int) "the issuer is asked once" 1 !asked

(* The issuer holds its answer to the kept sign-in's refresh while a refusal
   waits on it, and the session closes. *)
let kept_renewal_runs_to_its_end () =
  let open Semiont in
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
  in
  let known model body = Result.get_ok (Models.decode model body) in
  let endpoint =
    known Models.kb_endpoint
      {|{"kind":"http","host":"localhost","port":4010,"protocol":"http"}|}
  in
  let description =
    known Models.kb_description {|{"name":"KB","domain":"kb.example"}|}
  in
  let storage_data = Hashtbl.create 4 in
  let storage : Registry.storage =
    {
      read = Hashtbl.find_opt storage_data;
      write = Hashtbl.replace storage_data;
      remove = Hashtbl.remove storage_data;
    }
  in
  let browser =
    Registry.new_semiont_browser
      {
        storage;
        clock;
        fresh_id = (fun () -> "kb");
        factory = (fun _ -> assert false);
      }
  in
  let credential : Registry.stored_session =
    {
      access = "original";
      refresh = "refresh";
      client_id = "browser";
      token_endpoint = "https://issuer.example/token";
      revocation_endpoint = None;
    }
  in
  ignore
    (Result.get_ok
       (Registry.record_sign_in browser
          {
            endpoint;
            description;
            session = credential;
            kb_id = None;
            expected_did = None;
            expected_name = None;
          }));
  let kept = Registry.kept_in storage "kb" in
  let release, finish = Promise.create () in
  let asked = ref 0 in
  let issuer _ =
    incr asked;
    Promise.await release;
    (200, {|{"access_token":"renewed","refresh_token":"rotated"}|})
  in
  let session =
    Session.start ~keep_on_unavailable:true
      ~on_rejected:(Registry.forget_rejected browser "kb")
      ~sw ~clock ~initial_token:(Some "original")
      ~renew:(Registry.renew_kept browser ~http:issuer "kb")
      ()
  in
  let refused =
    Fiber.fork_promise ~sw (fun () ->
        Session.refresh_refused session ~refused:"original")
  in
  settle ();
  Session.close session;
  Alcotest.(check (option string))
    "the refusal waiting on the renewal is given no token at once" None
    (Promise.await_exn refused);
  let closed =
    Fiber.fork_promise ~sw (fun () -> Session.await_closed session)
  in
  settle ();
  Alcotest.(check bool)
    "the close waits for the renewal under way" false
    (Promise.is_resolved closed);
  Promise.resolve finish ();
  Promise.await_exn closed;
  Alcotest.(check (option string))
    "the kept sign-in holds the refresh token the renewal brought"
    (Some "rotated")
    (Option.map
       (fun (held : Registry.stored_session) -> held.refresh)
       (kept.held ()));
  Alcotest.(check (option string))
    "the closed session takes no token from it" None
    (Session.credential session);
  Alcotest.(check (option string))
    "a refusal once the session is closed is given no token" None
    (Session.refresh_refused session ~refused:"original");
  Alcotest.(check (option string))
    "a refusal of a token already replaced is given no token" None
    (Session.refresh_refused session ~refused:"renewed");
  Alcotest.(check int) "the issuer is asked once" 1 !asked

let lifecycle phase row =
  let open Semiont in
  let open Yojson.Safe.Util in
  Eio_mock.Backend.run @@ fun () ->
  Switch.run @@ fun sw ->
  let mono = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
    |> fun clock -> Clock.with_jitter clock (fun () -> 0.)
  in
  let known model body = Result.get_ok (Models.decode model body) in
  let endpoint =
    known Models.kb_endpoint
      {|{"kind":"http","host":"localhost","port":4010,"protocol":"http"}|}
  in
  let description =
    known Models.kb_description {|{"name":"KB","domain":"kb.example"}|}
  in
  let storage_data = Hashtbl.create 4 in
  let storage : Registry.storage =
    {
      read = Hashtbl.find_opt storage_data;
      write = Hashtbl.replace storage_data;
      remove = Hashtbl.remove storage_data;
    }
  in
  let browser =
    Registry.new_semiont_browser
      {
        storage;
        clock;
        fresh_id = (fun () -> "kb");
        factory = (fun _ -> assert false);
      }
  in
  let stored =
    if phase = "startup" then row |> member "stored" |> to_string
    else "unexpired"
  in
  let original =
    if stored = "expired" then token {|{"iat":-100,"exp":-1}|} else "original"
  in
  let kept = Registry.kept_in storage "kb" in
  let credential : Registry.stored_session =
    {
      access = original;
      refresh = "refresh";
      client_id = "browser";
      token_endpoint = "https://issuer.example/token";
      revocation_endpoint = None;
    }
  in
  let registered =
    Result.get_ok
      (Registry.record_sign_in browser
         {
           endpoint;
           description;
           session = credential;
           kb_id = None;
           expected_did = None;
           expected_name = None;
         })
  in
  if stored = "none" then kept.forget ();
  let asked = ref 0 and renewed = ref 0 and started = ref (phase = "startup") in
  let scripted name count =
    let answers = row |> member name |> to_list in
    let answer = List.nth answers (min !count (List.length answers - 1)) in
    incr count;
    to_string answer
  in
  let issuer _ =
    match scripted "issuer" renewed with
    | "renews" -> (200, {|{"access_token":"renewed","refresh_token":"rotated"}|})
    | "refuses" -> (400, {|{"error":"invalid_grant"}|})
    | "unreachable" -> (503, {|{}|})
    | _ -> assert false
  in
  let started_on = if stored = "none" then None else Some original in
  let handed = ref [] in
  let credentials =
    Session.start ~keep_on_unavailable:true
      ~on_rejected:(Registry.forget_rejected browser "kb")
      ~sw ~clock
      ~initial_token:
        (Option.map
           (fun (session : Registry.stored_session) -> session.access)
           (kept.held ()))
      ~renew:(fun ~holding ->
        handed := holding :: !handed;
        Registry.renew_kept browser ~http:issuer "kb" ~holding)
      ()
  in
  let call ~sw:_ ~meth:_ ~path ~headers:_ ~body:_ ~progress:_ =
    match path with
    | "/bus/subscribe" -> Fiber.await_cancel ()
    | "/api/users/me" ->
        let status, body =
          match if !started then scripted "gateway" asked else "accepts" with
          | "accepts" ->
              ( 200,
                {|{"did":"did:web:kb.example:users:alice","email":null,"name":"Alice","image":null,"domain":"kb.example"}|}
              )
          | "refuses" -> (401, "{}")
          | "unreachable" -> (503, "{}")
          | _ -> assert false
        in
        (status, [], Eio.Flow.string_source body)
    | _ -> assert false
  in
  let client =
    Client.connect ~sw ~clock ~session:credentials ~client_id:"test"
      ~key:(fun () -> "test")
      ~call ~global:Bus_registry.bridged_channels ~on_event:ignore ()
  in
  let module S = State_units.Session in
  let told = ref None in
  let session =
    S.make ~id:"kb" ~kb:registered.kb client ~on_auth_failed:(fun reason ->
        told :=
          Some
            (match reason with
            | S.Expired -> "expired"
            | S.Refused -> "refused"))
  in
  let reported = ref None in
  let _release =
    S.errors session
      ~on_value:(fun said ->
        reported :=
          Some
            (match said with
            | Client.Own { code; _ } | Client.Transport_failure { code; _ } ->
                code))
      ~on_close:ignore
  in
  S.ready session;
  if phase = "refusal" then (
    started := true;
    let refused =
      if row |> member "refused" |> to_string = "held" then original
      else "previous"
    in
    let given = S.refresh session ~refused () in
    Alcotest.(check bool)
      "given"
      (row |> member "given" |> to_bool)
      (Option.is_some given));
  let ends () =
    match
      (State_value.get (S.token session), State_value.get (S.user session))
    with
    | None, None -> "signed-out"
    | Some _, Some _ -> "signed-in"
    | Some _, None -> "unconfirmed"
    | None, Some _ -> "user without token"
  in
  let check_checkpoint expected =
    List.iter
      (Alcotest.(check (option string))
         "each renewal is handed the token it renews" started_on)
      (List.rev !handed);
    Alcotest.(check int)
      "gateway asks"
      (expected |> member "asks" |> to_int)
      !asked;
    Alcotest.(check int)
      "issuer renewals"
      (expected |> member "renewals" |> to_int)
      !renewed;
    Alcotest.(check string)
      "ends"
      (expected |> member "ends" |> to_string)
      (ends ())
  in
  check_checkpoint row;
  Alcotest.(check bool)
    "kept"
    (row |> member "kept" |> to_bool)
    (Option.is_some (kept.held ()));
  Alcotest.(check (option string))
    "told"
    (row |> member "told" |> to_string_option)
    !told;
  Alcotest.(check (option string))
    "error"
    (row |> member "error" |> to_string_option)
    !reported;
  (match member "then" row with
  | `Null -> ()
  | expected ->
      settle ();
      Eio_mock.Clock.Mono.set_time mono
        (Option.get
           (Mtime.add_span (Clock.monotonic_now clock) Mtime.Span.(6000 * ms)));
      settle ();
      check_checkpoint expected);
  S.dispose session;
  Client.close client;
  Client.await_closed client

let lifecycle_cases phase =
  let open Yojson.Safe.Util in
  Yojson.Safe.from_string Session_cases.cases
  |> member phase |> to_list
  |> List.map (fun row ->
      Alcotest.test_case
        (row |> member "why" |> to_string)
        `Quick
        (fun () -> lifecycle phase row))

let () =
  Alcotest.run "session renewal"
    [
      ("startup", lifecycle_cases "startup");
      ("refusal", lifecycle_cases "refusal");
      ( "session",
        [
          Alcotest.test_case "shared expiry and schedule" `Quick table;
          Alcotest.test_case "proactive and reactive share renewal" `Quick
            proactive;
          Alcotest.test_case
            "the backoff after an unanswered renewal is handed the token it \
             renews"
            `Quick backoff;
          Alcotest.test_case
            "a wait that runs out after a refusal's renewal renews nothing"
            `Quick replaced_before_due;
          Alcotest.test_case
            "a backoff that runs out after a refusal's renewal renews nothing"
            `Quick replaced_before_backoff;
          Alcotest.test_case
            "a renewal that comes back once the session is closed gives the \
             refusal no token and ends nothing"
            `Quick closed_before_answer_taken;
          Alcotest.test_case
            "a kept sign-in's renewal under way at close runs to its end and \
             keeps the refresh token it brings"
            `Quick kept_renewal_runs_to_its_end;
        ] );
    ]
