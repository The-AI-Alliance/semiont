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
    for _ = 1 to 12 do
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
  let call ~sw:_ ~meth:_ ~path ~headers:_ ~body ~progress:_ =
    match path with
    | "/bus/subscribe" -> (200, [], (read :> Eio.Flow.source_ty Eio.Resource.t))
    | "/bus/emit" ->
        sent := !sent @ [ Yojson.Safe.from_string body ];
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
      ~renew:(fun ~refused:_ -> Session.Refused)
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
  let watch name state encode =
    let _release =
      V.observe state ~on_value:ignore ~on_close:(fun () ->
          Hashtbl.replace ended name ())
    in
    (name, fun () -> encode (V.get state))
  in
  let made = field "unit" (field "made" row) in
  let dispose, invoke, values =
    match string "unit" row with
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
  List.iter
    (fun step ->
      match step with
      | `String "settle" -> settle ()
      | `Assoc fields -> (
          match List.hd fields with
          | "invoke", `String name -> invoke name (field "args" step)
          | "dispose", _ -> dispose ()
          | "pass", value ->
              settle ();
              let duration = elapsed value in
              Eio_mock.Clock.Mono.set_time mono
                (Option.get
                   (Mtime.add_span
                      (Clock.monotonic_now clock)
                      Mtime.Span.(duration * ms)));
              settle ()
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
                (fun (name, value) -> check value ((List.assoc name values) ()))
                (J.to_assoc (field "unit" expected))
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
                (fun name -> assert (Hashtbl.mem ended (J.to_string name)))
                (J.to_list (field "unit" ended_))
          | "busDestroyed", `Bool expected ->
              assert (
                Subscription.state (Client.subscription client)
                = Subscription.Closed = expected)
          | _ -> failwith ("unknown state unit step: " ^ json step))
      | _ -> assert false)
    (J.to_list (field "steps" row));
  dispose ();
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
