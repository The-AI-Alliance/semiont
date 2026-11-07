let refuse_extensions () =
  List.iter
    (fun source ->
      Alcotest.(check bool)
        ("refuse " ^ String.escaped source)
        true
        (Result.is_error (Strict_json.parse source)))
    [
      "NaN";
      "Infinity";
      "-Infinity";
      "+1";
      "01";
      "-.1";
      "1.";
      "1e";
      "1e+";
      "{x:1}";
      "[1,]";
      "{\"x\":1,}";
      "(1,2)";
      "<Tag>";
      "true false";
      "/* comment */ null";
      "// comment\n1";
      "\012null";
      "\239\187\191null";
      "\"\255\"";
      "\"\192\175\"";
      "\"\n\"";
      "\"\\x20\"";
      "\"\\uD800\"";
      "\"\\uDC00\"";
      "\"\\uD800\\u0041\"";
      "";
    ]

let valid_literals () =
  List.iter
    (fun source ->
      let value = Result.get_ok (Strict_json.parse source) in
      Alcotest.(check bool)
        "strict literal round trip" true
        (Yojson.Raw.equal value
           (Result.get_ok (Strict_json.parse (Yojson.Raw.to_string value)))))
    [
      "null";
      "false";
      "true";
      "-0";
      "1E+300";
      "-1.25e-300";
      "900719925474099312345678901234567890";
      "0.123456789012345678901234567890123456789";
      "\"\\uD83D\\uDE00\"";
      "\"\\u0000\\n\\t\"";
      "{\"absent\":[],\"nullable\":null,\"open\":{\"unknown\":true}}";
      String.make 300 '[' ^ "1" ^ String.make 300 ']';
    ]

let arbitrary_integers () =
  let generator =
    QCheck.Gen.(
      map2
        (fun head tail ->
          String.make 1 (Char.chr (head + Char.code '1'))
          ^ String.of_seq (List.to_seq tail))
        (int_bound 8)
        (list_size (int_range 0 500) (char_range '0' '9')))
  in
  let test =
    QCheck.Test.make ~count:200 (QCheck.make generator) (fun literal ->
        match Strict_json.parse literal with
        | Ok (`Intlit retained) -> literal = retained
        | _ -> false)
  in
  QCheck.Test.check_exn test

let () =
  Alcotest.run "OCaml strict JSON substrate"
    [
      ( "json",
        [
          Alcotest.test_case "reject extensions and malformed UTF-8" `Quick
            refuse_extensions;
          Alcotest.test_case "literal and nested fidelity" `Quick valid_literals;
          Alcotest.test_case "arbitrary-precision integer fidelity" `Quick
            arbitrary_integers;
        ] );
    ]
