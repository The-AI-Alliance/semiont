open Eio.Std
module Otel = Opentelemetry

(* Unicode_cases supplies the generated text/offset-cases.json corpus. *)
let span digit =
  Otel.Span.make
    ~trace_id:(Otel.Trace_id.of_hex (String.make 32 digit))
    ~id:(Otel.Span_id.of_hex (String.make 16 digit))
    ~start_time:0L ~end_time:1L "probe"

let current () =
  Option.map
    (fun span -> Otel.Span_id.to_hex (Otel.Span.id span))
    (Otel.Ambient_span.get ())

let telemetry () =
  let original = Ambient_context.get_current_storage () in
  Fun.protect
    ~finally:(fun () -> Ambient_context.set_current_storage original)
    (fun () ->
      Ambient_context.set_current_storage Ambient_context_eio.storage;
      Eio_main.run @@ fun env ->
      Switch.run @@ fun sw ->
      let entered, enter = Promise.create () in
      let release, unblock = Promise.create () in
      let a =
        Fiber.fork_promise ~sw (fun () ->
            Otel.Ambient_span.with_ambient (span '1') (fun () ->
                Promise.resolve enter ();
                Promise.await release;
                let child = Fiber.fork_promise ~sw current in
                Alcotest.(check (option string))
                  "child inherits its fiber's span"
                  (Some (String.make 16 '1'))
                  (Promise.await_exn child);
                let context = Ambient_context.get_context () in
                Eio.Domain_manager.run (Eio.Stdenv.domain_mgr env) (fun () ->
                    let previous = current () in
                    Ambient_context.with_context context (fun () ->
                        Alcotest.(check (option string))
                          "explicit context crosses the domain boundary"
                          (Some (String.make 16 '1'))
                          (current ()));
                    Alcotest.(check (option string))
                      "domain context is restored" previous (current ()));
                current ()))
      in
      let b =
        Fiber.fork_promise ~sw (fun () ->
            Promise.await entered;
            Otel.Ambient_span.with_ambient (span '2') (fun () ->
                Promise.resolve unblock ();
                let first = Promise.await_exn a in
                Alcotest.(check (option string))
                  "first fiber retained its span"
                  (Some (String.make 16 '1'))
                  first;
                current ()))
      in
      Alcotest.(check (option string))
        "interleaved second fiber retained its span"
        (Some (String.make 16 '2'))
        (Promise.await_exn b);
      Alcotest.(check (option string))
        "host ambient span restored" None (current ()))

let crypto () =
  Eio_main.run @@ fun env ->
  let nonce = Cstruct.create 32 in
  Eio.Flow.read_exact (Eio.Stdenv.secure_random env) nonce;
  Alcotest.(check int)
    "cryptographic bytes from host capability" 32 (Cstruct.length nonce);
  let key =
    Result.get_ok
      (X509.Private_key.decode_pem
         (In_channel.with_open_bin "peer-key.pem" In_channel.input_all))
  in
  let signature =
    Result.get_ok
      (X509.Private_key.sign `SHA256 ~scheme:`RSA_PKCS1 key (`Message "claims"))
  in
  let public = X509.Private_key.public key in
  Alcotest.(check bool)
    "RSA signature verifies" true
    (Result.is_ok
       (X509.Public_key.verify `SHA256 ~scheme:`RSA_PKCS1 ~signature public
          (`Message "claims")));
  Alcotest.(check bool)
    "changed message is refused" true
    (Result.is_error
       (X509.Public_key.verify `SHA256 ~scheme:`RSA_PKCS1 ~signature public
          (`Message "changed")))

let points text =
  Uutf.String.fold_utf_8
    (fun acc offset -> function
      | `Uchar point -> (offset, Uchar.to_int point) :: acc
      | `Malformed _ -> failwith "malformed UTF-8")
    [] text
  |> List.rev |> Array.of_list

let unicode () =
  List.iter
    (fun (text, count, spans) ->
      let scalars = points text in
      Alcotest.(check int)
        "shared code point count" count (Array.length scalars);
      let byte index =
        if index = count then String.length text else fst scalars.(index)
      in
      List.iter
        (fun (exact, occurrence, start, finish) ->
          Alcotest.(check string)
            "shared scalar offsets select the exact UTF-8 bytes" exact
            (String.sub text (byte start) (byte finish - byte start));
          let needle = points exact in
          let rec find index seen =
            if index + Array.length needle > count then
              failwith "occurrence not found";
            let matches =
              Array.for_all
                (fun (at, scalar) -> snd scalars.(index + at) = scalar)
                (Array.mapi (fun at (_, scalar) -> (at, scalar)) needle)
            in
            if matches && seen + 1 = occurrence then index
            else find (index + 1) (if matches then seen + 1 else seen)
          in
          Alcotest.(check int)
            "search returns the shared scalar start" start (find 0 0))
        spans)
    Unicode_cases.cases;
  let malformed =
    try
      ignore (points "\255");
      false
    with Failure _ -> true
  in
  Alcotest.(check bool) "malformed UTF-8 is distinguishable" true malformed

let () =
  Mirage_crypto_rng_unix.use_default ();
  Alcotest.run "OCaml host capabilities"
    [
      ( "capabilities",
        [
          Alcotest.test_case
            "OTel fiber isolation and explicit domain propagation" `Quick
            telemetry;
          Alcotest.test_case "host secure random and RSA" `Quick crypto;
          Alcotest.test_case "shared scalar offset corpus" `Quick unicode;
        ] );
    ]
