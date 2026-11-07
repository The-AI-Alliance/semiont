module Bus = Semiont.Bus_registry
module Selector = Semiont.Selector

let selector json =
  let parsed = Yojson.Safe.from_string json in
  match Selector.of_json parsed with
  | Error _ -> Alcotest.fail "valid selector was refused"
  | Ok decoded ->
      Alcotest.(check string)
        "selector round trip" json
        (Yojson.Safe.to_string (Selector.to_json decoded))

let refuses json member reason =
  match Selector.of_json (Yojson.Safe.from_string json) with
  | Ok _ -> Alcotest.fail "invalid selector was accepted"
  | Error fault ->
      Alcotest.(check string) "fault member" member fault.member;
      Alcotest.(check bool) "fault reason" true (reason = fault.reason)

let selectors () =
  selector
    {|{"type":"TextPositionSelector","start":0,"end":9223372036854775808,"extension":null}|};
  selector {|{"type":"TextQuoteSelector","exact":"a","suffix":"b"}|};
  selector {|{"type":"SvgSelector","value":"<svg/>"}|};
  selector {|{"type":"FragmentSelector","value":"page=1"}|};
  refuses {|{"type":"Unknown"}|} "type" `Malformed;
  refuses {|{"type":"TextQuoteSelector","exact":"a","suffix":null}|} "suffix"
    `Malformed;
  refuses {|{"type":"TextPositionSelector","start":-1,"end":2}|} "start"
    `Malformed;
  refuses {|{"type":"TextPositionSelector","start":0}|} "end" `Lacks

let operations () =
  Alcotest.(check bool)
    "browse operation reads" true
    (Bus.operation_effect Bus.Operations.browse_resource_requested
    = Some Bus.Reads);
  Alcotest.(check bool)
    "creation is broadcast" true
    (Bus.audience Bus.Channels.yield_created = Some Bus.Everyone);
  let registered = Hashtbl.create 256 in
  List.iter
    (fun (Bus.Channel channel) ->
      let name = Bus.name channel in
      if Hashtbl.mem registered name then
        Alcotest.fail ("duplicate channel " ^ name);
      Hashtbl.add registered name ())
    Bus.channels;
  List.iter
    (fun (Bus.Operation operation) ->
      let request = Bus.request operation in
      let result = Bus.result operation in
      let failure = Bus.failure operation in
      Alcotest.(check bool)
        "operation request is emittable" true (Bus.emittable request);
      List.iter
        (fun name ->
          Alcotest.(check bool)
            "operation channel is registered" true
            (Hashtbl.mem registered name))
        [ Bus.name request; Bus.name result; Bus.name failure ];
      Alcotest.(check bool)
        "operation replies are correlated" true
        (Bus.delivery result = Some Bus.Correlated
        && Bus.delivery failure = Some Bus.Correlated))
    Bus.operations

let payload_codecs () =
  let round_trip channel source =
    let decoded = Result.get_ok (Bus.decode channel source) in
    Alcotest.(check string) "wire literal preserved" source (Bus.encode decoded)
  in
  let refuse channel source member reason =
    match Bus.decode channel source with
    | Error (Bus.Invalid_payload fault) ->
        Alcotest.(check string) "fault member" member fault.member;
        Alcotest.(check bool) "fault reason" true (fault.reason = reason)
    | _ -> Alcotest.fail "expected a payload fault"
  in
  let module C = Bus.Channels in
  round_trip C.browse_resource_requested
    {|{"resourceId":"res-1","extension":[null,0.123456789012345678901,1e1000000000]}|};
  round_trip C.job_cancel_ok {|{"response":{"cancelled":true}}|};
  round_trip C.mark_archive_ok "{}";
  round_trip C.yield_created
    {|{"id":"event","type":"yield:created","timestamp":"2026-11-07","userId":"did:web:example:alice","version":1,"payload":{"name":"a","format":"text/plain","contentChecksum":"hash"},"metadata":{"sequenceNumber":1}}|};
  refuse C.yield_created
    {|{"id":"event","type":"yield:created","timestamp":"2026-11-07","userId":"did:web:example:alice","version":1,"payload":{},"metadata":{"sequenceNumber":1}}|}
    "payload.name" `Lacks;
  refuse C.browse_resource_requested {|{"resourceId":null}|} "resourceId" `Lacks;
  refuse C.browse_resource_requested {|{"resourceId":"bad/path"}|} "resourceId"
    `Malformed;
  refuse C.job_cancel_ok {|{"response":{"cancelled":"yes"}}|}
    "response.cancelled" `Malformed;
  refuse C.job_cancel_ok {|{}|} "response" `Lacks;
  refuse C.mark_archive_ok {|{"z":0,"a":0}|} "a" `Malformed;
  match Bus.decode C.mark_archive_ok "{/* comment */}" with
  | Error (Bus.Invalid_json _) -> ()
  | _ -> Alcotest.fail "expected a strict JSON fault"

let component_codecs () =
  let module M = Semiont.Models in
  let round_trip model source =
    Alcotest.(check string)
      "component literal preserved" source
      (M.encode (Result.get_ok (M.decode model source)))
  in
  round_trip M.bus_frame {|{"channel":"mark:archive-ok","payload":{}}|};
  round_trip M.selector
    {|{"type":"TextPositionSelector","start":0.0,"end":1e1000000000}|};
  match
    M.decode M.selector
      {|{"type":"TextPositionSelector","start":-0.00000000000000000001,"end":1}|}
  with
  | Error (M.Invalid_payload { member = "start"; reason = `Malformed }) -> ()
  | _ -> Alcotest.fail "expected a union branch fault at start"

let record_views () =
  let module M = Semiont.Models in
  let module R = Semiont.Records in
  let module T = Semiont.Types in
  let frame =
    Result.get_ok
      (M.decode M.bus_frame
         {|{"channel":"mark:archive-ok","correlationId":null,"payload":{}}|})
    |> R.Bus_frame.of_model
  in
  Alcotest.(check bool)
    "null remains distinct from absence" true
    (frame.correlation_id = T.Null && frame.scope = T.Absent);
  let endpoint =
    Result.get_ok
      (M.decode M.kb_endpoint
         {|{"kind":"http","host":"example.org","port":443,"protocol":"https","hint":null}|})
    |> R.Kb_endpoint.of_model
  in
  (match endpoint with
  | Some (R.Kb_endpoint.Http view) ->
      Alcotest.(check string) "typed union selects HTTP" "example.org" view.host;
      Alcotest.(check bool)
        "open property retained" true
        (view.extra = [ ("hint", `Null) ])
  | _ -> Alcotest.fail "expected HTTP endpoint variant");
  let outcome =
    Result.get_ok
      (M.decode M.extraction_outcome
         {|{"kind":"extracted","method":"text-passthrough","text":"sample","items":[]}|})
    |> R.Extraction_outcome.of_model
  in
  match outcome with
  | Some (R.Extraction_outcome.Extracted view) ->
      Alcotest.(check string) "composed record inherits text" "sample" view.text;
      Alcotest.(check string)
        "composed record keeps branch method" "text-passthrough" view.method_
  | _ -> Alcotest.fail "expected extracted variant"

let () =
  Alcotest.run "generated protocol"
    [
      ( "models",
        [ Alcotest.test_case "selector records and union" `Quick selectors ] );
      ( "bus",
        [
          Alcotest.test_case "typed operation facts" `Quick operations;
          Alcotest.test_case "payload codecs" `Quick payload_codecs;
        ] );
      ( "components",
        [
          Alcotest.test_case "component codecs" `Quick component_codecs;
          Alcotest.test_case "record and variant views" `Quick record_views;
        ] );
    ]
