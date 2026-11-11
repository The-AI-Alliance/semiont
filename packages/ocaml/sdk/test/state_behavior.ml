open Eio.Std
open Semiont
module U = State_units
module V = State_value
module B = Bus_registry
module J = Yojson.Safe.Util

let field = J.member
let string key row = J.to_string (field key row)
let text value = `String value
let option read = function `Null -> None | value -> Some (read value)
let nullable write = function None -> `Null | Some value -> write value

let id value =
  Result.get_ok (Identifiers.Annotation_id.of_string (J.to_string value))

let annotation value =
  nullable (fun id -> text (Identifiers.Annotation_id.to_string id)) value

let json = Yojson.Safe.to_string
let assoc fields = `Assoc fields

let rec normalize = function
  | `Assoc fields ->
      assoc
        (List.sort compare (List.map (fun (k, v) -> (k, normalize v)) fields))
  | `List values -> `List (List.map normalize values)
  | value -> value

let check expected actual =
  Alcotest.(check string)
    "state behavior"
    (json (normalize expected))
    (json (normalize actual))

let rec matches expected actual =
  match (expected, actual) with
  | `Assoc [ ("$has", `Assoc wanted) ], `Assoc fields ->
      List.for_all
        (fun (name, value) ->
          match List.assoc_opt name fields with
          | Some actual -> matches value actual
          | None -> false)
        wanted
  | `Assoc [ ("code", code) ], `Assoc fields
    when List.mem_assoc "message" fields ->
      List.assoc_opt "code" fields = Some code
  | `List a, `List b ->
      List.length a = List.length b && List.for_all2 matches a b
  | _ -> normalize expected = normalize actual

let rec substitute fixture = function
  | `Assoc [ ("$fixture", `String name) ] ->
      substitute fixture (field name fixture)
  | `Assoc fields ->
      assoc
        (List.map (fun (key, value) -> (key, substitute fixture value)) fields)
  | `List values -> `List (List.map (substitute fixture) values)
  | value -> value

(* Public units driven by the shared client/state-units.json cases. *)
let run_case row =
  Eio_main.run @@ fun env ->
  Switch.run @@ fun sw ->
  let mono = Eio_mock.Clock.Mono.make () in
  let clock =
    Clock.make ~monotonic:mono ~wall:(Eio.Stdenv.clock env)
      ~jitter:(Random.State.make [| 1 |])
  in
  let timing = Yojson.Safe.from_string State_cases.timing in
  let number fallback = function
    | `Int n -> float n
    | `Float n -> n
    | _ -> fallback
  in
  let elapsed = function
    | `Int n -> n
    | value ->
        let base = J.to_int (field (string "timing" value) timing) in
        int_of_float
          ((float base *. number 1. (field "times" value))
          +. number 0. (field "plusMs" value))
  in
  let settle () =
    for _ = 1 to 40 do
      Fiber.yield ()
    done
  in
  let listen =
    match field "listen" row with
    | `List names -> List.map J.to_string names
    | _ -> []
  in
  let heard = ref [] in
  let on_event = function
    | Ok (Wire_stream.Frame { route; payload = Ok payload; _ })
      when List.mem route.channel listen ->
        let fields =
          [
            ("channel", text route.channel);
            ("payload", Yojson.Safe.from_string (B.encode payload));
          ]
        in
        let fields =
          fields
          @ Option.to_list
              (Option.map
                 (fun id -> ("correlationId", text id))
                 route.correlation_id)
        in
        heard := assoc fields :: !heard
    | _ -> ()
  in
  let read, write = Eio.Process.pipe ~sw (Eio.Stdenv.process_mgr env) in
  let sent = ref [] in
  let send_frame ?correlation_id channel payload =
    let fields =
      [ ("channel", text channel); ("payload", payload) ]
      @ Option.to_list
          (Option.map (fun id -> ("correlationId", text id)) correlation_id)
    in
    Eio.Flow.copy_string
      ("event: bus-event\ndata: " ^ json (assoc fields) ^ "\n\n")
      write
  in
  let transport = field "transport" row in
  let replies = Hashtbl.create 4 in
  (match field "replies" transport with
  | `Assoc entries ->
      List.iter
        (fun (name, values) -> Hashtbl.replace replies name (J.to_list values))
        entries
  | _ -> ());
  let enqueue name response =
    let values = Option.value (Hashtbl.find_opt replies name) ~default:[] in
    Hashtbl.replace replies name (values @ [ response ])
  in
  let automatic request =
    let name = string "channel" request in
    let explicit =
      match Hashtbl.find_opt replies name with
      | Some (response :: rest) ->
          Hashtbl.replace replies name rest;
          Some response
      | _ -> None
    in
    let response =
      match (explicit, field "answers" transport, name) with
      | Some response, _, _ -> Some response
      | None, `String "jobs", "job:create" ->
          Some (assoc [ ("jobId", text "job-1") ])
      | None, `String "jobs", "job:status-requested" ->
          Some
            (assoc
               [
                 ("jobId", text "job-1");
                 ("status", text "running");
                 ("type", field "unit" row);
                 ("userId", text "did:web:example.org:users:alice");
                 ("created", text "2026-10-01T00:00:00.000Z");
               ])
      | _ -> None
    in
    let operation =
      List.find_opt
        (fun (B.Operation operation) -> B.name (B.request operation) = name)
        B.operations
    in
    match (operation, response) with
    | Some (B.Operation operation), Some response -> (
        let correlation_id = string "correlationId" request in
        let reply = B.name (B.result operation) in
        let deliver () =
          send_frame ~correlation_id reply (assoc [ ("response", response) ])
        in
        match field "delayMs" transport with
        | `Int delay ->
            let deadline =
              Option.get
                (Mtime.add_span
                   (Clock.monotonic_now clock)
                   Mtime.Span.(delay * ms))
            in
            Fiber.fork_daemon ~sw (fun () ->
                Clock.sleep_until clock deadline;
                deliver ();
                `Stop_daemon)
        | _ -> deliver ())
    | Some (B.Operation operation), None
      when field "answers" transport = text "refuses"
           || name = "mark:create-request"
              && field "answers" transport = text "jobs" ->
        send_frame
          ~correlation_id:(string "correlationId" request)
          (B.name (B.failure operation))
          (assoc [ ("message", text "refused") ])
    | _ -> ()
  in
  let call ~sw:_ ~meth:_ ~path ~headers:_ ~body ~progress:_ =
    match path with
    | "/bus/subscribe" -> (200, [], (read :> Eio.Flow.source_ty Eio.Resource.t))
    | "/bus/emit" ->
        let request = Yojson.Safe.from_string body in
        sent := !sent @ [ request ];
        automatic request;
        (202, [], Eio.Flow.string_source "{}")
    | _ -> failwith "unexpected HTTP request in state unit case"
  in
  let on_channel name =
    List.filter (fun row -> string "channel" row = name) !sent
  in
  let correlation channel nth =
    string "correlationId" (List.nth (on_channel channel) nth)
  in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some "state-token")
      ~renew:(fun ~holding:_ -> Session.Refused)
      ()
  in
  let serial = ref 0 in
  let client =
    Client.connect ~sw ~clock ~session ~client_id:"state-test"
      ~key:(fun () ->
        incr serial;
        "state-" ^ string_of_int !serial)
      ~call ~global:[] ~on_event ~on_error:ignore ()
  in
  let local ?correlation_id channel payload =
    let (B.Channel channel) =
      List.find (fun (B.Channel value) -> B.name value = channel) B.channels
    in
    Client.publish client ?correlation_id channel
      (Result.get_ok (B.decode channel (json payload)))
  in
  let searched = ref [] and answers = ref [] in
  let lookup query receive =
    let active = ref true in
    searched := !searched @ [ text query ];
    answers := !answers @ [ (fun value -> if !active then receive value) ];
    fun () -> active := false
  in
  let ended = Hashtbl.create 8 in
  let watch unit_name name state encode =
    let _release =
      V.observe state ~on_value:ignore ~on_close:(fun () ->
          Hashtbl.replace ended (unit_name, name) ())
    in
    (name, fun () -> encode (V.get state))
  in
  let make unit_name made =
    let watch name state encode = watch unit_name name state encode in
    match string "unit" row with
    | "mark" ->
        let module M = U.Mark in
        let resource =
          Result.get_ok
            (Identifiers.Resource_id.of_string (string "resourceId" made))
        in
        let unit = M.make client ~resource in
        let invoke name args =
          match name with
          | "cancelPending" -> M.cancel_pending unit
          | "dismissProgress" -> M.dismiss_progress unit
          | "requestDelegate" ->
              M.request_delegate unit
                (Result.get_ok
                   (Models.decode Models.mark_job_params
                      (json (field "params" args))))
          | _ -> assert false
        in
        let failure (value : Delegation.failure) =
          assoc
            ([ ("code", text value.code) ]
            @ Option.to_list
                (Option.map
                   (fun message -> ("message", text message))
                   value.message))
        in
        ( (fun () -> M.dispose unit),
          invoke,
          [
            watch "pendingAnnotation"
              (M.pending_annotation unit)
              (nullable (fun (pending : M.pending_annotation) ->
                   assoc
                     [
                       ("selector", pending.selector);
                       ("motivation", text pending.motivation);
                     ]));
            watch "delegatingMotivation"
              (M.delegating_motivation unit)
              (nullable text);
            watch "progressMotivation"
              (M.progress_motivation unit)
              (nullable text);
            watch "progress" (M.progress unit) (nullable Fun.id);
            watch "failure" (M.failure unit) (nullable failure);
            watch "jobId" (M.job_id unit) (nullable text);
          ] )
    | "yield" ->
        let module Y = U.Yield in
        let unit = Y.make client ~locale:(string "locale" made) in
        let invoke name args =
          match name with
          | "dismissProgress" -> Y.dismiss_progress unit
          | "generate" ->
              Y.generate unit
                ?stall_ms:(option elapsed (field "stallDeadlineMs" args))
                (Result.get_ok
                   (Models.decode Models.generation_job_request
                      (json (field "params" args))))
          | _ -> assert false
        in
        let failure (value : Delegation.failure) =
          assoc
            ([ ("code", text value.code) ]
            @ Option.to_list
                (Option.map
                   (fun message -> ("message", text message))
                   value.message))
        in
        ( (fun () -> Y.dispose unit),
          invoke,
          [
            watch "isGenerating" (Y.is_generating unit) (fun value ->
                `Bool value);
            watch "progress" (Y.progress unit) (nullable Fun.id);
            watch "outcome" (Y.outcome unit) (nullable Fun.id);
            watch "failure" (Y.failure unit) (nullable failure);
            watch "jobId" (Y.job_id unit) (nullable text);
          ] )
    | "match" ->
        let unit = U.Match.make client in
        ((fun () -> U.Match.dispose unit), (fun _ _ -> assert false), [])
    | "gather" ->
        let module G = U.Gather in
        let resource name value =
          Result.get_ok (Identifiers.Resource_id.of_string (string name value))
        in
        let unit = G.make client ~resource:(resource "resourceId" made) in
        let invoke name args =
          match name with
          | "gatherAnnotation" ->
              G.gather_annotation unit
                ?context_window:(option J.to_int (field "contextWindow" args))
                ?include_source_context:
                  (option J.to_bool (field "includeSourceContext" args))
                ?include_target_context:
                  (option J.to_bool (field "includeTargetContext" args))
                (id (field "annotationId" args))
          | "gatherResource" ->
              G.gather_resource unit (resource "resourceId" args)
          | _ -> assert false
        in
        let identity value = value and bool value = `Bool value in
        ( (fun () -> G.dispose unit),
          invoke,
          [
            watch "context" (G.context unit) (nullable identity);
            watch "loading" (G.loading unit) bool;
            watch "error" (G.error unit) (nullable identity);
            watch "annotationId" (G.annotation_id unit) annotation;
            watch "resourceContext" (G.resource_context unit)
              (nullable identity);
            watch "resourceLoading" (G.resource_loading unit) bool;
            watch "resourceError" (G.resource_error unit) (nullable identity);
          ] )
    | "hoverDwell" ->
        let unit =
          U.Hover_dwell.make ~delay_ms:(elapsed (field "delayMs" made)) client
        in
        ( (fun () -> U.Hover_dwell.dispose unit),
          (fun name args ->
            match name with
            | "enter" ->
                U.Hover_dwell.enter unit (id (field "annotationId" args))
            | "leave" -> U.Hover_dwell.leave unit
            | _ -> assert false),
          [] )
    | "beckon" ->
        let resource =
          Result.get_ok
            (Identifiers.Resource_id.of_string (string "resourceId" made))
        in
        let unit = U.Beckon.make client ~resource in
        ( (fun () -> U.Beckon.dispose unit),
          (fun name args ->
            assert (name = "focus");
            U.Beckon.focus unit (id (field "annotationId" args))),
          [
            watch "hoveredAnnotationId"
              (U.Beckon.hovered_annotation_id unit)
              annotation;
          ] )
    | "search" ->
        let debounce_ms = option elapsed (field "debounceMs" made) in
        let initial_query = option J.to_string (field "initialQuery" made) in
        let unit =
          U.Search.make ?debounce_ms ?initial_query ~sw ~clock ~search:lookup ()
        in
        ( (fun () -> U.Search.dispose unit),
          (fun name args ->
            assert (name = "setQuery");
            U.Search.set_query unit (string "value" args)),
          [
            watch "query" (U.Search.query unit) text;
            watch "state" (U.Search.state unit) (fun state ->
                assoc
                  [
                    ("results", `List state.results);
                    ("isSearching", `Bool state.is_searching);
                  ]);
          ] )
    | "sessionSignals" ->
        let module N = U.Session_signals in
        let unit = N.make () in
        ( (fun () -> N.dispose unit),
          (fun name args ->
            match name with
            | "notifySessionEnded" ->
                N.notify_session_ended unit ~reason:(string "reason" args)
            | "notifyPermissionDenied" ->
                N.notify_permission_denied unit
                  ~detail:(option J.to_string (field "detail" args))
            | "notifyKbIdentityConflict" ->
                let row = field "conflict" args in
                N.notify_kb_identity_conflict unit
                  {
                    expected_did = string "expectedDid" row;
                    observed_did = string "observedDid" row;
                  }
            | "acknowledgeSessionEnded" -> N.acknowledge_session_ended unit
            | "acknowledgePermissionDenied" ->
                N.acknowledge_permission_denied unit
            | "acknowledgeKbIdentityConflict" ->
                N.acknowledge_kb_identity_conflict unit
            | _ -> assert false),
          [
            watch "sessionEnded" (N.session_ended unit)
              (nullable (fun value -> assoc [ ("reason", text value.N.reason) ]));
            watch "permissionDenied" (N.permission_denied unit)
              (nullable (fun value ->
                   assoc [ ("detail", nullable text value.N.detail) ]));
            watch "kbIdentityConflict"
              (N.kb_identity_conflict unit)
              (nullable (fun value ->
                   assoc
                     [
                       ("expectedDid", text value.N.expected_did);
                       ("observedDid", text value.N.observed_did);
                     ]));
          ] )
    | _ -> assert false
  in
  let units =
    List.map
      (fun (name, config) -> (name, make name config))
      (J.to_assoc (field "made" row))
  in
  List.iter
    (fun step ->
      match step with
      | `String "settle" -> settle ()
      | `Assoc fields -> (
          match List.hd fields with
          | "invoke", `String name ->
              let _, invoke, _ = List.assoc (string "of" step) units in
              invoke name (field "args" step)
          | "dispose", `String name ->
              let dispose, _, _ = List.assoc name units in
              dispose ()
          | "pass", value ->
              settle ();
              let duration = elapsed value in
              Eio_mock.Clock.Mono.set_time mono
                (Option.get
                   (Mtime.add_span
                      (Clock.monotonic_now clock)
                      Mtime.Span.(duration * ms)));
              settle ()
          | "queueReply", `String channel ->
              enqueue channel (field "response" step)
          | "say", `String channel
            when String.starts_with ~prefix:"job:" channel ->
              send_frame channel (field "payload" step)
          | "say", `String channel ->
              local
                ?correlation_id:
                  (option J.to_string (field "correlationId" step))
                channel (field "payload" step)
          | "deliver", `String channel ->
              settle ();
              send_frame channel (field "payload" step);
              settle ()
          | "nothingSent", _ ->
              settle ();
              check (`List []) (`List !sent)
          | "sent", `String channel -> (
              settle ();
              let messages = on_channel channel in
              match field "count" step with
              | `Int expected ->
                  Alcotest.(check int)
                    "sent count" expected (List.length messages)
              | _ ->
                  let expected = field "payloads" step in
                  let actual = `List (List.map (field "payload") messages) in
                  if not (matches expected actual) then check expected actual)
          | "answer", `String channel ->
              settle ();
              let correlation_id =
                correlation channel (J.to_int (field "nth" step))
              in
              send_frame ~correlation_id (string "reply" step)
                (field "payload" step);
              settle ()
          | "expect", expected ->
              List.iter
                (fun (unit_name, expected) ->
                  let _, _, values = List.assoc unit_name units in
                  List.iter
                    (fun (name, value) ->
                      let actual = (List.assoc name values) () in
                      if not (matches value actual) then check value actual)
                    (J.to_assoc expected))
                (J.to_assoc expected)
          | "heard", expected ->
              settle ();
              let expected =
                J.to_list expected
                |> List.map (fun row ->
                    match field "correlationId" row with
                    | `Assoc ref_ ->
                        let actual =
                          correlation
                            (string "sent" (`Assoc ref_))
                            (J.to_int (field "nth" (`Assoc ref_)))
                        in
                        assoc
                          (("correlationId", text actual)
                          :: List.remove_assoc "correlationId" (J.to_assoc row)
                          )
                    | _ -> row)
              in
              let actual = List.rev !heard in
              let matches_payload expected actual =
                normalize
                  (assoc (List.remove_assoc "payload" (J.to_assoc expected)))
                = normalize
                    (assoc (List.remove_assoc "payload" (J.to_assoc actual)))
                && matches (field "payload" expected) (field "payload" actual)
              in
              if
                List.length expected <> List.length actual
                || not (List.for_all2 matches_payload expected actual)
              then check (`List expected) (`List actual);
              heard := []
          | "searched", expected ->
              settle ();
              check expected (`List !searched)
          | "answerSearch", `Int index ->
              (List.nth !answers index)
                (option J.to_list (field "results" step));
              settle ()
          | "ended", ended_ ->
              List.iter
                (fun (unit_name, names) ->
                  List.iter
                    (fun name ->
                      assert (Hashtbl.mem ended (unit_name, J.to_string name)))
                    (J.to_list names))
                (J.to_assoc ended_)
          | "busDestroyed", `Bool expected ->
              assert (
                Subscription.state (Client.subscription client)
                = Subscription.Closed = expected)
          | _ -> failwith ("unknown state unit step: " ^ json step))
      | _ -> assert false)
    (J.to_list (field "steps" row));
  List.iter (fun (_, (dispose, _, _)) -> dispose ()) units;
  Client.close client;
  Session.close session

let () =
  let fixture = Yojson.Safe.from_string State_cases.fixtures in
  let cases =
    Yojson.Safe.from_string State_cases.cases
    |> J.to_list
    |> List.map (substitute fixture)
  in
  Alcotest.run "OCaml state units"
    [
      ( "shared",
        List.map
          (fun row ->
            Alcotest.test_case (string "case" row) `Quick (fun () ->
                run_case row))
          cases );
    ]
