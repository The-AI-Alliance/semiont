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

let () =
  Alcotest.run "generated protocol"
    [
      ( "models",
        [ Alcotest.test_case "selector records and union" `Quick selectors ] );
      ("bus", [ Alcotest.test_case "typed operation facts" `Quick operations ]);
    ]
