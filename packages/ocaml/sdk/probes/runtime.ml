open Eio.Std

let check = Alcotest.(check bool)

exception Wrong_domain

let domain_affinity () =
  Eio_main.run @@ fun env ->
  let owner = Domain.self () in
  let guard () = if Domain.self () <> owner then raise Wrong_domain in
  guard ();
  let refused, immutable_id =
    Eio.Domain_manager.run (Eio.Stdenv.domain_mgr env) (fun () ->
        let refused =
          match guard () with () -> false | exception Wrong_domain -> true
        in
        ( refused,
          Semiont.Identifiers.Resource_id.of_string
            "resource-from-another-domain" ))
  in
  check "effectful candidate guard refuses the wrong domain" true refused;
  Alcotest.(check string)
    "immutable typed IDs cross domains" "resource-from-another-domain"
    (Semiont.Identifiers.Resource_id.to_string (Result.get_ok immutable_id))

let shared_renewal () =
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun sw ->
  let grant, issue = Promise.create () in
  let calls = ref 0 in
  let renewal =
    Fiber.fork_promise ~sw (fun () ->
        incr calls;
        Promise.await grant)
  in
  let attached, attach = Promise.create () in
  let cancelled_waiter =
    Fiber.fork_promise ~sw (fun () ->
        try
          Eio.Cancel.sub (fun cancel ->
              Promise.resolve attach cancel;
              ignore (Promise.await_exn renewal));
          false
        with Eio.Cancel.Cancelled _ -> true)
  in
  let survivor = Fiber.fork_promise ~sw (fun () -> Promise.await_exn renewal) in
  Eio.Cancel.cancel (Promise.await attached) Exit;
  check "cancelled waiter exits" true (Promise.await_exn cancelled_waiter);
  check "shared renewal outlives the waiter" true (Promise.peek renewal = None);
  check "surviving waiter is still waiting" true (Promise.peek survivor = None);
  Promise.resolve issue "issued once";
  Alcotest.(check string)
    "survivor receives the renewal" "issued once"
    (Promise.await_exn survivor);
  Alcotest.(check int) "one provider call" 1 !calls

let ordered_fanout () =
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun sw ->
  let slow = Eio.Stream.create max_int and fast = Eio.Stream.create max_int in
  let release, unblock = Promise.create () in
  let values = List.init 1000 Fun.id in
  let consume queue pause =
    List.map
      (fun _ ->
        let value = Eio.Stream.take queue in
        pause value;
        value)
      values
  in
  let slow_reader =
    Fiber.fork_promise ~sw (fun () ->
        consume slow (fun value -> if value = 0 then Promise.await release))
  in
  let fast_reader = Fiber.fork_promise ~sw (fun () -> consume fast ignore) in
  List.iter
    (fun value ->
      Eio.Stream.add slow value;
      Eio.Stream.add fast value)
    values;
  Alcotest.(check (list int))
    "fast reader sees every item in order" values
    (Promise.await_exn fast_reader);
  check "slow reader is still held at its callback" true
    (Promise.peek slow_reader = None);
  Promise.resolve unblock ();
  Alcotest.(check (list int))
    "slow reader has its own complete ordered queue" values
    (Promise.await_exn slow_reader)

let close_from_callback () =
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun caller ->
  let stop, stop_owner = Promise.create () in
  let closed, close_owner = Promise.create () in
  let ready, publish_ready = Promise.create () in
  let finalized = ref false in
  Fiber.fork ~sw:caller (fun () ->
      Fun.protect
        ~finally:(fun () -> Promise.resolve close_owner ())
        (fun () ->
          Switch.run (fun owned ->
              let running, run = Promise.create () in
              Fiber.fork_daemon ~sw:owned (fun () ->
                  Fun.protect
                    ~finally:(fun () -> finalized := true)
                    (fun () ->
                      Promise.resolve run ();
                      Fiber.await_cancel ()));
              Promise.await running;
              Promise.resolve publish_ready ();
              Promise.await stop)));
  Promise.await ready;
  let closing = Atomic.make false in
  let close () =
    Eio.Cancel.protect (fun () ->
        if Atomic.compare_and_set closing false true then
          Promise.resolve stop_owner ();
        Promise.await closed)
  in
  let callback =
    Fiber.fork_promise ~sw:caller (fun () ->
        close ();
        !finalized)
  in
  let concurrent = Fiber.fork_promise ~sw:caller close in
  check "callback-owned reader can close and join the owner" true
    (Promise.await_exn callback);
  Promise.await_exn concurrent;
  close ();
  let borrowed =
    Fiber.fork_promise ~sw:caller (fun () -> "caller still runs")
  in
  Alcotest.(check string)
    "close did not cancel the caller switch" "caller still runs"
    (Promise.await_exn borrowed)

let failed_startup () =
  Eio_main.run @@ fun _ ->
  let finalized = ref false in
  let failed =
    match
      Switch.run (fun sw ->
          let ready, start = Promise.create () in
          Fiber.fork_daemon ~sw (fun () ->
              Fun.protect
                ~finally:(fun () -> finalized := true)
                (fun () ->
                  Promise.resolve start ();
                  Fiber.await_cancel ()));
          Promise.await ready;
          raise Exit)
    with
    | () -> false
    | exception Exit -> true
  in
  check "startup failure escapes" true failed;
  check "failed startup joined owned child cleanup" true !finalized

let caller_clock () =
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun sw ->
  let monotonic = Eio_mock.Clock.Mono.make () in
  let wall = Eio_mock.Clock.make () in
  let jitter = Random.State.make [| 19 |] in
  let expected = Random.State.copy jitter in
  let module Clock = Semiont.Clock in
  let clock = Clock.make ~monotonic ~wall ~jitter in
  let start = Clock.monotonic_now clock in
  let due = Option.get (Mtime.add_span start (Mtime.Span.of_uint64_ns 2L)) in
  let before = Option.get (Mtime.add_span start (Mtime.Span.of_uint64_ns 1L)) in
  let waiting =
    Fiber.fork_promise ~sw (fun () -> Clock.sleep_until clock due)
  in
  Eio_mock.Clock.set_time wall 12.;
  Eio_mock.Clock.Mono.set_time monotonic before;
  Alcotest.(check (float 0.))
    "reads the supplied wall clock" 12. (Clock.wall_now clock);
  check "monotonic time follows its own clock" true
    (Mtime.equal before (Clock.monotonic_now clock));
  check "wait stays pending before the deadline" false
    (Promise.is_resolved waiting);
  Eio_mock.Clock.Mono.set_time monotonic due;
  Promise.await_exn waiting;
  Alcotest.(check (float 0.))
    "draws from the supplied jitter state"
    (Random.State.float expected 1.)
    (Clock.jitter clock);
  Alcotest.(check (float 0.))
    "the caller observes the same advanced state"
    (Random.State.float expected 1.)
    (Random.State.float jitter 1.)

let () =
  Alcotest.run "OCaml ownership substrate"
    [
      ( "ownership",
        [
          Alcotest.test_case
            "explicit effectful domain affinity and immutable IDs" `Quick
            domain_affinity;
          Alcotest.test_case "one cancelled waiter cannot cancel renewal" `Quick
            shared_renewal;
          Alcotest.test_case "ordered independent readers" `Quick ordered_fanout;
          Alcotest.test_case "callback and concurrent close join owned work"
            `Quick close_from_callback;
          Alcotest.test_case "failed startup joins cleanup" `Quick
            failed_startup;
          Alcotest.test_case "caller controls time and jitter" `Quick
            caller_clock;
        ] );
    ]
