module T = Semiont.Telemetry

let text value = `String value

let number value =
  text (Int64.to_string (Int64.of_float (value *. 1_000_000_000.)))

let attributes pairs =
  `List
    (List.map
       (fun (key, value) ->
         let name, value =
           match value with
           | T.String value -> ("stringValue", text value)
           | T.Int value -> ("intValue", text (string_of_int value))
           | T.Bool value -> ("boolValue", `Bool value)
         in
         `Assoc [ ("key", text key); ("value", `Assoc [ (name, value) ]) ])
       pairs)

let make ~id ~post =
  let spans = ref [] in
  let counters = ref [] in
  let telemetry : T.t =
    {
      span = (fun span -> spans := span :: !spans);
      increment = (fun point -> counters := point :: !counters);
    }
  in
  let span (value : T.span) =
    let kind =
      match value.kind with T.Client -> 3 | T.Producer -> 4 | T.Consumer -> 5
    in
    `Assoc
      [
        ("traceId", text (id ()));
        ("spanId", text (String.sub (id ()) 0 16));
        ("name", text value.name);
        ("kind", `Int kind);
        ("startTimeUnixNano", number value.started);
        ("endTimeUnixNano", number value.ended);
        ("attributes", attributes value.attributes);
      ]
  in
  let metric (point : T.counter) =
    `Assoc
      [
        ("name", text point.name);
        ( "sum",
          `Assoc
            [
              ("aggregationTemporality", `Int 1);
              ("isMonotonic", `Bool true);
              ( "dataPoints",
                `List
                  [
                    `Assoc
                      [
                        ("timeUnixNano", number point.time);
                        ("asInt", text "1");
                        ("attributes", attributes point.attributes);
                      ];
                  ] );
            ] );
      ]
  in
  let export path resource scope items values =
    if values <> [] then
      post path
        (Yojson.Safe.to_string
           (`Assoc
              [
                ( resource,
                  `List
                    [
                      `Assoc
                        [ (scope, `List [ `Assoc [ (items, `List values) ] ]) ];
                    ] );
              ]))
  in
  let flush () =
    let pending_spans = List.rev_map span !spans in
    let pending_metrics = List.rev_map metric !counters in
    spans := [];
    counters := [];
    export "/v1/traces" "resourceSpans" "scopeSpans" "spans" pending_spans;
    export "/v1/metrics" "resourceMetrics" "scopeMetrics" "metrics"
      pending_metrics
  in
  (telemetry, flush)
