open Eio.Std
module Session = Semiont.Session

let token claims =
  "header."
  ^ Base64.encode_exn ~pad:false ~alphabet:Base64.uri_safe_alphabet claims
  ^ ".signature"

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
      ~renew:(fun ~refused ->
        incr calls;
        Alcotest.(check (option string))
          "proactive renewal has no refusal" None refused;
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

let () =
  Alcotest.run "session renewal"
    [
      ( "session",
        [
          Alcotest.test_case "shared expiry and schedule" `Quick table;
          Alcotest.test_case "proactive and reactive share renewal" `Quick
            proactive;
        ] );
    ]
