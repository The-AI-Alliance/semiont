open Semiont
module J = Yojson.Safe.Util

let field = J.member
let text value = `String value
let nullable f value = Option.fold ~none:`Null ~some:f value
let texts values = `List (List.map text values)

let rec normalized = function
  | `Assoc fields ->
      `Assoc
        (List.sort compare
           (List.map (fun (name, value) -> (name, normalized value)) fields))
  | `List values -> `List (List.map normalized values)
  | `Float value when Float.is_integer value && abs_float value < 1e15 ->
      `Int (int_of_float value)
  | value -> value

let check label expected actual =
  Alcotest.(check string)
    label
    (Yojson.Safe.to_string (normalized expected))
    (Yojson.Safe.to_string (normalized actual))

let request_routing row source =
  let open Eio.Std in
  match field "request" row with
  | `Null -> ()
  | `String verdict ->
      Eio_main.run @@ fun env ->
      Switch.run @@ fun sw ->
      let read, write = Eio.Process.pipe ~sw (Eio.Stdenv.process_mgr env) in
      let clock =
        Clock.make
          ~monotonic:(Eio_mock.Clock.Mono.make ())
          ~wall:(Eio_mock.Clock.make ())
          ~jitter:(Random.State.make [| 1 |])
      in
      let seen, observe = Promise.create () in
      let operation = Bus_registry.Operations.browse_resource_requested in
      let global = Bus.reply_channels_for operation in
      let sub =
        Subscription.start ~sw ~clock ~client_id:"test" ~global ~scopes:[]
          ~connect:(fun ~sw:_ _ ->
            Ok (Eio.Buf_read.of_flow ~max_size:65536 read))
          ~on_event:(fun _ ->
            if not (Promise.is_resolved seen) then Promise.resolve observe ())
          ()
      in
      let request =
        Fiber.fork_promise ~sw (fun () ->
            Subscription.request sub ~normalize_refusals:true
              ~correlation_id:"c-1"
              Bus_registry.Operations.browse_resource_requested ~send:(fun () ->
                Eio.Flow.copy_string source write))
      in
      Fun.protect
        ~finally:(fun () ->
          Subscription.close sub;
          Subscription.await_closed sub)
        (fun () ->
          let arrived =
            Fiber.first
              (fun () ->
                Promise.await seen;
                true)
              (fun () ->
                Eio.Time.sleep (Eio.Stdenv.clock env) 1.;
                false)
          in
          Alcotest.(check bool) "frame arrived" true arrived;
          if verdict = "fails" then
            match Promise.await_exn request with
            | Error (Subscription.Frame_refusal fault) ->
                Alcotest.(check string)
                  "request fault member"
                  (J.to_string (field "member" row))
                  fault.member
            | _ -> Alcotest.fail "request did not receive the frame fault"
          else
            Alcotest.(check bool)
              "request is still pending" false
              (Promise.is_resolved request))
  | _ -> Alcotest.fail "unknown request verdict"

(* What a case of bus/frame-cases.json may state. *)
let frame_case_keys =
  [
    "why";
    "frame";
    "data";
    "read";
    "refused";
    "member";
    "reason";
    "told";
    "correlationId";
    "request";
  ]

(* The channels the table's delivered frames are read on by type. *)
let typed_channels =
  let open Bus_registry in
  List.map
    (fun (Channel channel) -> name channel)
    [
      Channel Channels.beckon_focus;
      Channel Channels.browse_resource_failed;
      Channel Channels.gather_failed;
    ]

(* Shared cases from bus/frame-cases.json. *)
let frame row =
  List.iter
    (fun (key, _) ->
      if not (List.mem key frame_case_keys) then
        Alcotest.failf
          "a frame case states `%s`, which this runner does not know" key)
    (J.to_assoc row);
  let source =
    match field "data" row with
    | `String data -> data
    | _ -> Yojson.Safe.to_string (field "frame" row)
  in
  let message = "event: bus-event\ndata: " ^ source ^ "\n\n" in
  request_routing row message;
  let input = Eio.Flow.string_source message in
  let raw =
    Wire_stream.read (Eio.Buf_read.of_flow ~max_size:65536 input) |> Option.get
  in
  let result = Wire_stream.normalized raw in
  match (field "refused" row, result) with
  | `Bool true, Error fault ->
      check "member" (field "member" row) (text fault.member);
      check "reason" (field "reason" row)
        (text
           (match fault.reason with
           | `Lacks -> "lacks"
           | `Malformed -> "malformed"));
      check "recipient" (field "told" row)
        (text
           (if Option.is_some fault.route then "readers" else "failure-report"));
      check "correlation"
        (field "correlationId" row)
        (nullable text
           (Option.bind fault.route (fun route -> route.correlation_id)))
  | `Null, _ -> (
      (* Envelope acceptance is distinct from the typed payload result. *)
      match Result.get_ok raw with
      | Wire_stream.Frame { route; payload; _ } -> (
          let expected = field "frame" row in
          check "channel" (field "channel" expected) (text route.channel);
          check "correlation"
            (field "correlationId" expected)
            (nullable text route.correlation_id);
          check "scope" (field "scope" expected)
            (nullable
               (fun value -> text (Identifiers.Resource_id.to_string value))
               route.scope);
          let read =
            match field "read" row with
            | `Null -> field "payload" expected
            | read -> read
          in
          match (List.mem route.channel typed_channels, payload) with
          | true, Ok payload ->
              check "read" read
                (Yojson.Safe.from_string (Bus_registry.encode payload))
          | true, Error _ ->
              Alcotest.fail "the typed reader refused the payload"
          | false, _ when field "read" row <> `Null ->
              Alcotest.fail "a read is stated on a channel not read by type"
          | false, _ -> ()))
  | _ -> Alcotest.fail "unexpected frame refusal result"

(* Shared cases from annotations/reader-cases.json. *)
let annotation row =
  let module A = Annotations in
  let annotation =
    Models.decode Models.annotation
      (Yojson.Safe.to_string (field "annotation" row))
    |> Result.get_ok |> A.of_model
  in
  let selection = A.target_selector annotation in
  let reads =
    [
      ("bodySource", nullable text (A.body_source annotation));
      ("targetSource", text (A.target_source annotation));
      ("targetSelector", nullable Fun.id selection);
      ("isBodyResolved", `Bool (A.is_body_resolved annotation));
      ("isHighlight", `Bool (A.is_highlight annotation));
      ("isReference", `Bool (A.is_reference annotation));
      ("isAssessment", `Bool (A.is_assessment annotation));
      ("isComment", `Bool (A.is_comment annotation));
      ("isTag", `Bool (A.is_tag annotation));
      ("commentText", nullable text (A.comment_text annotation));
      ("isStubReference", `Bool (A.is_stub_reference annotation));
      ("isResolvedReference", `Bool (A.is_resolved_reference annotation));
      ("exactText", text (A.exact_text selection));
      ("annotationExactText", text (A.annotation_exact_text annotation));
      ( "textQuoteSelector",
        nullable Fun.id (Option.bind selection A.text_quote_selector) );
      ("entityTypes", texts (A.entity_types annotation));
      ("tagCategory", nullable text (A.tag_category annotation));
      ("tagSchemaId", nullable text (A.tag_schema_id annotation));
    ]
  in
  List.iter
    (fun (key, value) -> check key value (List.assoc key reads))
    (J.to_assoc (field "reads" row))

(* Shared cases from resources/reader-cases.json. *)
let resource row =
  let model =
    Models.decode Models.resource_descriptor
      (Yojson.Safe.to_string (field "resource" row))
  in
  match (field "refused" row, model) with
  | `Bool true, Error (Models.Invalid_payload fault) ->
      check "member" (field "member" row) (text fault.member);
      check "reason" (field "reason" row)
        (text
           (match fault.reason with
           | `Lacks -> "lacks"
           | `Malformed -> "malformed"))
  | `Null, Ok model ->
      check "primary representation"
        (field "primaryRepresentation" row)
        (nullable
           (fun value -> Yojson.Safe.from_string (Yojson.Raw.to_string value))
           (Resources.primary_representation model));
      check "primary media type"
        (field "primaryMediaType" row)
        (nullable text (Resources.primary_media_type model));
      check "entity types" (field "entityTypes" row)
        (texts (Resources.entity_types model))
  | _ -> Alcotest.fail "unexpected resource decode result"

let string key row = J.to_string (field key row)

let optional key row =
  match field key row with `Null -> None | value -> Some value

let number key row = J.to_number (field key row)
let int key row = J.to_int (field key row)

let parse schema value =
  Models.decode schema (Yojson.Safe.to_string value) |> Result.get_ok

let quote row : Annotations.quoted_text =
  {
    exact = string "exact" row;
    prefix = J.to_string_option (field "prefix" row);
    suffix = J.to_string_option (field "suffix" row);
  }

(* Shared deterministic IDs from annotations/id-cases.json. *)
let identity row =
  let actual =
    Annotation_id.derive ~resource_id:(string "resourceId" row)
      ~motivation:(string "motivation" row) ~anchor:(string "anchor" row)
      (optional "body" row)
  in
  check "id" (field "id" row) (text actual)

(* Shared whole-resource and span builders from annotations/builder-cases.json. *)
let builder row =
  let module A = Annotations in
  let resource =
    Identifiers.Resource_id.of_string (string "resourceId" row) |> Result.get_ok
  in
  let motivation =
    Enums.Motivation.of_string (string "motivation" row) |> Option.get
  in
  let generator = optional "generator" row and body = optional "body" row in
  let created = "2026-01-01T00:00:00.000Z" in
  let build () =
    match optional "span" row with
    | None ->
        A.annotation_of_resource ~created ~resource ~motivation ?generator ?body
          ()
    | Some span ->
        let offset key =
          let value = number key span in
          if Float.is_integer value then int_of_float value else -1
        in
        let selection : A.text_span =
          { start = offset "start"; end_ = offset "end"; quote = quote span }
        in
        let content =
          match optional "anchored" row with
          | Some value -> A.Pdf (parse Models.anchored_text value)
          | None -> A.Text (string "text" row)
        in
        A.annotation_of_span ~created ~resource ~motivation
          ~generator:(Option.get generator) ?body content selection
  in
  match build () with
  | Ok model ->
      let fields =
        Yojson.Safe.from_string (Models.encode model) |> J.to_assoc
      in
      check "created" (text created) (List.assoc "created" fields);
      check "annotation" (field "annotation" row)
        (`Assoc (List.remove_assoc "created" fields))
  | Error _ -> Alcotest.fail "builder produced an invalid annotation"
  | exception A.Span_refused { code } ->
      let code =
        match code with
        | A.Span_out_of_range -> "span-out-of-range"
        | Item_out_of_range -> "item-out-of-range"
        | Exact_mismatch -> "exact-mismatch"
        | Nothing_located -> "nothing-located"
        | Exact_not_covered -> "exact-not-covered"
        | Prefix_mismatch -> "prefix-mismatch"
        | Suffix_mismatch -> "suffix-mismatch"
      in
      check "refusal" (field "refused" row) (text code)

(* Shared Unicode anchors from annotations/reconcile-cases.json. *)
let reconcile row =
  let module A = Annotations in
  let actual = A.reconcile (string "text" row) (quote (field "quoted" row)) in
  let to_json (result : A.reconciled_span) =
    let span = result.span in
    let field name value =
      Option.to_list (Option.map (fun value -> (name, text value)) value)
    in
    let method_ =
      match result.anchor_method with
      | A.Unique_match -> "unique-match"
      | Context_recovered -> "context-recovered"
      | First_of_many -> "first-of-many"
      | Fuzzy_match -> "fuzzy-match"
    in
    let quality =
      Option.map
        (function
          | A.Normalized -> "normalized"
          | Case_insensitive -> "case-insensitive"
          | Fuzzy -> "fuzzy")
        result.match_quality
    in
    `Assoc
      ([
         ("start", `Int span.start);
         ("end", `Int span.end_);
         ("exact", text span.quote.exact);
         ("anchorMethod", text method_);
       ]
      @ field "prefix" span.quote.prefix
      @ field "suffix" span.quote.suffix
      @ field "matchQuality" quality)
  in
  check "reconciled span" (field "reconciled" row) (nullable to_json actual)

(* SDK geometry cases from annotations/pdf-locate-cases.json. *)
let pdf row =
  let module A = Annotations in
  let items = field "items" (field "anchored" row) |> J.to_list in
  let read item : A.pdf_item =
    {
      start = int "start" item;
      end_ = int "end" item;
      page = int "page" item;
      x = number "x" item;
      y = number "y" item;
      width = number "width" item;
      height = number "height" item;
    }
  in
  let entries = List.map (fun raw -> (read raw, raw)) items in
  let span = field "span" row in
  let overlaps, rectangles =
    A.locate_pdf (List.map fst entries) (int "start" span) (int "end" span)
  in
  check "overlaps" (field "overlapping" row)
    (`List (List.map (fun item -> List.assq item entries) overlaps));
  check "rectangles" (field "rects" row) (`List rectangles);
  check "fragments" (field "fragments" row)
    (texts (List.map A.fragment rectangles))

(* Shared failure retry decisions from jobs/retry-cases.json. *)
let retry row =
  let classification =
    Option.bind
      (J.to_string_option (field "failureClass" row))
      Enums.Failure_class.of_string
  in
  let result =
    Claims.will_retry_after ~retry_count:(int "retryCount" row)
      ~max_retries:(int "maxRetries" row) classification
  in
  check "retries" (field "retries" row) (`Bool result)

let cases table test =
  Yojson.Safe.from_string table
  |> J.to_list
  |> List.map (fun row ->
      Alcotest.test_case
        (J.to_string (field "why" row))
        `Quick
        (fun () -> test row))

let () =
  Alcotest.run "OCaml reader helpers"
    [
      ("frames", cases Helper_cases.table_0 frame);
      ("annotations", cases Helper_cases.table_1 annotation);
      ("resources", cases Helper_cases.table_2 resource);
      ("span builders", cases Helper_cases.table_3 builder);
      ("resource builders", cases Helper_cases.resource_builders builder);
      ("annotation ids", cases Helper_cases.table_4 identity);
      ("reconciliation", cases Helper_cases.table_5 reconcile);
      ("PDF locations", cases Helper_cases.table_6 pdf);
      ("job retry", cases Helper_cases.table_7 retry);
    ]
