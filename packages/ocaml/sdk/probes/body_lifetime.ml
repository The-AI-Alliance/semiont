open Eio.Std

let closed use =
  match use () with _ -> false | exception Scoped_body.Closed -> true

let one_consumer () =
  Eio_main.run @@ fun _ ->
  let retained =
    Scoped_body.with_body (Eio.Flow.string_source "buffered bytes") (fun body ->
        let reader = Scoped_body.consume body Fun.id in
        Alcotest.(check bool)
          "reader expires with its consumption callback" true
          (closed (fun () -> Scoped_body.read reader (Cstruct.create 1)));
        let second =
          match Scoped_body.consume body ignore with
          | () -> false
          | exception Scoped_body.Already_consumed -> true
        in
        Alcotest.(check bool) "a second consumer is refused" true second;
        body)
  in
  Alcotest.(check bool)
    "retained body cannot be reopened" true
    (closed (fun () -> Scoped_body.consume retained ignore))

let cancellation () =
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun sw ->
  let attached, attach = Promise.create () in
  let retained = ref None in
  let work =
    Fiber.fork_promise ~sw (fun () ->
        try
          Eio.Cancel.sub (fun cancel ->
              Scoped_body.with_body (Eio.Flow.string_source "buffered bytes")
                (fun body ->
                  Scoped_body.consume body (fun reader ->
                      retained := Some reader;
                      Promise.resolve attach cancel;
                      Fiber.await_cancel ())))
        with Eio.Cancel.Cancelled _ -> ())
  in
  Eio.Cancel.cancel (Promise.await attached) Exit;
  Promise.await_exn work;
  Alcotest.(check bool)
    "buffered bytes cannot escape a cancelled body scope" true
    (closed (fun () ->
         Scoped_body.read (Option.get !retained) (Cstruct.create 1)))

let () =
  Alcotest.run "OCaml scoped body candidate"
    [
      ( "lifetime",
        [
          Alcotest.test_case "single consumer and retained reader refusal"
            `Quick one_consumer;
          Alcotest.test_case "cancellation invalidates retained reader" `Quick
            cancellation;
        ] );
    ]
