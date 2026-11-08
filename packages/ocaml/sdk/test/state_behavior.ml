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
        heard :=
          assoc
            [
              ("channel", text route.channel);
              ("payload", Yojson.Safe.from_string (B.encode payload));
            ]
          :: !heard
    | _ -> ()
  in
  let read, write = Eio.Process.pipe ~sw (Eio.Stdenv.process_mgr env) in
  let call ~sw:_ ~meth:_ ~path ~headers:_ ~body:_ ~progress:_ =
    if path = "/bus/subscribe" then
      (200, [], (read :> Eio.Flow.source_ty Eio.Resource.t))
    else failwith "unexpected HTTP request in state unit case"
  in
  let session =
    Session.start ~sw ~clock ~initial_token:(Some "state-token")
      ~renew:(fun ~refused:_ -> Session.Refused)
      ()
  in
  let client =
    Client.connect ~sw ~clock ~session ~client_id:"state-test"
      ~key:(fun () -> "state-id")
      ~call ~global:[] ~on_event ~on_error:ignore ()
  in
  let local channel payload =
    let (B.Channel channel) =
      List.find (fun (B.Channel value) -> B.name value = channel) B.channels
    in
    Client.publish client channel
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
          | "say", `String channel -> local channel (field "payload" step)
          | "deliver", `String channel ->
              settle ();
              Eio.Flow.copy_string
                ("event: bus-event\ndata: "
                ^ json
                    (assoc
                       [
                         ("channel", text channel);
                         ("payload", field "payload" step);
                       ])
                ^ "\n\n")
                write;
              settle ()
          | "expect", expected ->
              List.iter
                (fun (name, value) -> check value ((List.assoc name values) ()))
                (J.to_assoc (field "unit" expected))
          | "heard", expected ->
              settle ();
              check expected (`List (List.rev !heard));
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
  let cases = Yojson.Safe.from_string State_cases.cases |> J.to_list in
  Alcotest.run "OCaml state units"
    [
      ( "shared",
        List.map
          (fun row ->
            Alcotest.test_case (string "case" row) `Quick (fun () ->
                run_case row))
          cases );
    ]
