let raw_json () =
  let source =
    "{\"large\":9007199254740993123456789,\"decimal\":0.12345678901234567890123456789,\"nullable\":null}"
  in
  let raw = Yojson.Raw.from_string source in
  let fields =
    match raw with `Assoc fields -> fields | _ -> failwith "object expected"
  in
  Alcotest.(check bool)
    "absent is absent" false
    (List.mem_assoc "missing" fields);
  Alcotest.(check bool)
    "null is null" true
    (List.assoc "nullable" fields = `Null);
  Alcotest.(check string)
    "integer retained" "9007199254740993123456789"
    (match List.assoc "large" fields with
    | `Intlit value -> value
    | _ -> failwith "integer literal expected");
  Alcotest.(check string)
    "decimal retained" "0.12345678901234567890123456789"
    (match List.assoc "decimal" fields with
    | `Floatlit value -> value
    | _ -> failwith "decimal literal expected");
  Alcotest.(check bool)
    "round trip" true
    (Yojson.Raw.equal raw (Yojson.Raw.from_string (Yojson.Raw.to_string raw)))

let presence () =
  let distinguish : int Semiont.Types.presence -> string = function
    | Absent -> "absent"
    | Null -> "null"
    | Present value -> string_of_int value
  in
  Alcotest.(check (list string))
    "three meanings" [ "absent"; "null"; "7" ]
    (List.map distinguish [ Absent; Null; Present 7 ])

let exact_numbers () =
  let integer = Z.of_string "9007199254740993123456789" in
  Alcotest.(check string)
    "integer is not a machine int" "9007199254740993123456789"
    (Z.to_string integer);
  let value = Decimal.of_string "0.123456789012345678901234567890123456789" in
  let expected =
    Q.make
      (Z.of_string "123456789012345678901234567890123456789")
      (Z.pow (Z.of_int 10) 39)
  in
  Alcotest.(check bool)
    "decimal retains its entire coefficient" true
    (Q.equal expected (Decimal.to_rational value));
  Alcotest.(check bool)
    "exponent is exact" true
    (Decimal.equal (Decimal.of_string "1e3") (Decimal.of_int 1000))

let owned_fibers () =
  Eio_main.run @@ fun _ ->
  let finalized = ref false in
  Eio.Switch.run (fun sw ->
      Eio.Fiber.fork_daemon ~sw (fun () ->
          Fun.protect
            ~finally:(fun () -> finalized := true)
            (fun () -> Eio.Fiber.await_cancel ()));
      Eio.Fiber.yield ());
  Alcotest.(check bool) "scope joins child cleanup" true !finalized

let () =
  Alcotest.run "OCaml substrate"
    [
      ( "json",
        [
          Alcotest.test_case "literal fidelity" `Quick raw_json;
          Alcotest.test_case "exact numbers" `Quick exact_numbers;
          Alcotest.test_case "optional nullable membership" `Quick presence;
        ] );
      ( "ownership",
        [ Alcotest.test_case "owned fiber cleanup" `Quick owned_fibers ] );
    ]
