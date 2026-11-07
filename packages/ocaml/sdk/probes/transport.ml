open Eio.Std

let check = Alcotest.(check bool)
let read_body body = Eio.Buf_read.(take_all (of_flow ~max_size:65536 body))
let pem file = In_channel.with_open_bin file In_channel.input_all

let value = function
  | Ok value -> value
  | Error (`Msg message) -> failwith message

let request flow =
  let input = Eio.Buf_read.of_flow ~max_size:65536 flow in
  let first = Eio.Buf_read.line input in
  let rec headers acc =
    match Eio.Buf_read.line input with
    | "" -> List.rev acc
    | line -> headers (line :: acc)
  in
  (first, headers [], input)

let with_listener env use =
  Switch.run @@ fun sw ->
  let socket =
    Eio.Net.listen ~sw ~backlog:5 (Eio.Stdenv.net env)
      (`Tcp (Eio.Net.Ipaddr.V4.loopback, 0))
  in
  let address = Eio.Net.listening_addr socket in
  let port = match address with `Tcp (_, port) -> port | _ -> assert false in
  use sw socket address port

let client env address connects =
  Cohttp_eio.Client.make_generic (fun ~sw _ ->
      incr connects;
      (Eio.Net.connect ~sw (Eio.Stdenv.net env) address
        :> [ Eio.Flow.two_way_ty | Eio.Resource.close_ty ] Eio.Resource.t))

let explicit_connection_policy () =
  Eio_main.run @@ fun env ->
  with_listener env @@ fun sw socket address port ->
  let connects = ref 0 in
  let http = client env address connects in
  let server =
    Fiber.fork_promise ~sw (fun () ->
        for _ = 1 to 2 do
          Switch.run @@ fun sw ->
          let flow, _ = Eio.Net.accept ~sw socket in
          ignore (request flow);
          Eio.Flow.copy_string
            "HTTP/1.1 302 Found\r\n\
             Location: /redirected\r\n\
             Content-Length: 2\r\n\
             \r\n\
             ok"
            flow
        done)
  in
  for _ = 1 to 2 do
    Switch.run @@ fun sw ->
    let response, body =
      Cohttp_eio.Client.get http ~sw
        (Uri.of_string (Printf.sprintf "http://localhost:%d/original" port))
    in
    Alcotest.(check int)
      "redirect is returned to policy owner" 302
      (Cohttp.Code.code_of_status (Cohttp.Response.status response));
    Alcotest.(check string) "complete response" "ok" (read_body body)
  done;
  Promise.await_exn server;
  Alcotest.(check int)
    "one connection per call; no implicit pool or redirect" 2 !connects

let no_hidden_retry () =
  Eio_main.run @@ fun env ->
  with_listener env @@ fun sw socket address port ->
  let connects = ref 0 in
  let http = client env address connects in
  let server =
    Fiber.fork_promise ~sw (fun () ->
        Switch.run @@ fun sw ->
        let flow, _ = Eio.Net.accept ~sw socket in
        ignore (request flow))
  in
  let refused =
    try
      Switch.run (fun sw ->
          ignore
            (Cohttp_eio.Client.get http ~sw
               (Uri.of_string
                  (Printf.sprintf "http://localhost:%d/closed" port))));
      false
    with Failure message -> message = "connection closed by peer"
  in
  check "premature EOF is reported" true refused;
  Promise.await_exn server;
  Alcotest.(check int) "no implicit retry" 1 !connects

let borrowed_connection () =
  Eio_main.run @@ fun env ->
  with_listener env @@ fun sw socket address port ->
  let accepted = ref 0 in
  let peer =
    Fiber.fork_promise ~sw (fun () ->
        let flow, _ = Eio.Net.accept ~sw socket in
        incr accepted;
        for _ = 1 to 2 do
          ignore (request flow);
          Eio.Flow.copy_string "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok"
            flow
        done)
  in
  let borrowed = Eio.Net.connect ~sw (Eio.Stdenv.net env) address in
  let http =
    Cohttp_eio.Client.make_generic (fun ~sw:_ _ ->
        (borrowed
          :> [ Eio.Flow.two_way_ty | Eio.Resource.close_ty ] Eio.Resource.t))
  in
  for _ = 1 to 2 do
    Switch.run @@ fun request_scope ->
    let _, body =
      Cohttp_eio.Client.get http ~sw:request_scope
        (Uri.of_string (Printf.sprintf "http://localhost:%d/borrowed" port))
    in
    Alcotest.(check string)
      "borrowed connection remains usable" "ok" (read_body body)
  done;
  Promise.await_exn peer;
  Alcotest.(check int)
    "closing request scopes preserves the host-owned connection" 1 !accepted

type stall = Headers | Body | Handshake

let controlled_deadline stall () =
  Eio_main.run @@ fun env ->
  with_listener env @@ fun sw socket address port ->
  let base = Eio_mock.Clock.Mono.make () in
  let expected =
    Option.get
      (Mtime.add_span (Eio.Time.Mono.now base)
         (Mtime.Span.of_uint64_ns 1_000_000_000L))
  in
  let armed, arm = Promise.create () in
  let module Clock = struct
    type t = unit
    type time = Mtime.t

    let now () = Eio.Time.Mono.now base

    let sleep_until () due =
      Promise.resolve arm due;
      Eio.Time.Mono.sleep_until base due
  end in
  let clock = Eio.Resource.T ((), Eio.Time.Pi.clock (module Clock)) in
  let received, receive = Promise.create () in
  let reading, read = Promise.create () in
  let peer_closed =
    Fiber.fork_promise ~sw (fun () ->
        Switch.run @@ fun sw ->
        let flow, _ = Eio.Net.accept ~sw socket in
        (match stall with
        | Handshake ->
            let bytes = Eio.Flow.single_read flow (Cstruct.create 4096) in
            check "peer received a real TLS ClientHello" true (bytes > 0)
        | Headers -> ignore (request flow)
        | Body ->
            ignore (request flow);
            Eio.Flow.copy_string "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\na"
              flow);
        Promise.resolve receive ();
        let rec closed () =
          try
            ignore (Eio.Flow.single_read flow (Cstruct.create 4096));
            match stall with Handshake -> closed () | Headers | Body -> false
          with End_of_file -> true
        in
        closed ())
  in
  let connects = ref 0 in
  let http =
    match stall with
    | Headers | Body -> client env address connects
    | Handshake ->
        let certificate =
          value (X509.Certificate.decode_pem (pem "peer-cert.pem"))
        in
        let time () = Ptime.of_float_s (Eio.Time.now (Eio.Stdenv.clock env)) in
        let authenticator =
          X509.Authenticator.chain_of_trust ~time [ certificate ]
        in
        let config = value (Tls.Config.client ~authenticator ()) in
        Cohttp_eio.Client.make_generic (fun ~sw _ ->
            incr connects;
            let raw = Eio.Net.connect ~sw (Eio.Stdenv.net env) address in
            (Tls_eio.client_of_flow config
               ~host:
                 (Domain_name.host_exn (Domain_name.of_string_exn "localhost"))
               raw
              :> [ Eio.Flow.two_way_ty | Eio.Resource.close_ty ] Eio.Resource.t))
  in
  let done_ =
    Fiber.fork_promise ~sw (fun () ->
        try
          Switch.run (fun sw ->
              Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds clock 1.)
                (fun () ->
                  let _, body =
                    Cohttp_eio.Client.get http ~sw
                      (Uri.of_string
                         (Printf.sprintf "%s://localhost:%d/stall"
                            (match stall with
                            | Handshake -> "https"
                            | Headers | Body -> "http")
                            port))
                  in
                  Promise.resolve read ();
                  ignore (read_body body)));
          false
        with Eio.Time.Timeout -> true)
  in
  let due = Promise.await armed in
  check "timer is registered at the requested deadline" true
    (Mtime.equal due expected);
  Promise.await received;
  (match stall with Headers | Handshake -> () | Body -> Promise.await reading);
  let before = Mtime.of_uint64_ns (Int64.pred (Mtime.to_uint64_ns expected)) in
  let boundary =
    Fiber.fork_promise ~sw (fun () -> Eio.Time.Mono.sleep_until base before)
  in
  Eio_mock.Clock.Mono.set_time base before;
  Promise.await_exn boundary;
  check "real IO does not auto-advance the controlled clock" true
    (Promise.peek done_ = None);
  Eio_mock.Clock.Mono.set_time base due;
  check "deadline cancels outstanding native IO" true (Promise.await_exn done_);
  check "request scope closed the socket" true (Promise.await_exn peer_closed);
  Alcotest.(check int) "cancellation does not retry" 1 !connects

exception Early_deadline

let early_timer_refused () =
  Eio_main.run @@ fun _ ->
  let expected = Mtime.of_uint64_ns 1_000_000_000L in
  let module Clock = struct
    type t = unit
    type time = Mtime.t

    let now () = Mtime.of_uint64_ns 0L

    let sleep_until () due =
      if Mtime.is_earlier due ~than:expected then raise Early_deadline;
      Fiber.await_cancel ()
  end in
  let clock = Eio.Resource.T ((), Eio.Time.Pi.clock (module Clock)) in
  let refused =
    match
      Eio.Time.Timeout.run_exn (Eio.Time.Timeout.seconds clock 0.5) (fun () ->
          Fiber.await_cancel ())
    with
    | () -> false
    | exception Early_deadline -> true
  in
  check "deadline observer rejects a deliberately early native timer" true
    refused

let replayable_upload () =
  Eio_main.run @@ fun env ->
  with_listener env @@ fun sw socket address port ->
  let payload = "complete upload \000 with UTF-8 \240\159\152\128" in
  let connects = ref 0 and opens = ref 0 in
  let http = client env address connects in
  let open_body () =
    incr opens;
    Cohttp_eio.Body.of_string payload
  in
  let peer =
    Fiber.fork_promise ~sw (fun () ->
        for attempt = 1 to 2 do
          Switch.run @@ fun sw ->
          let flow, _ = Eio.Net.accept ~sw socket in
          let _, headers, input = request flow in
          let length =
            List.find_map
              (fun line ->
                match String.split_on_char ':' line with
                | [ name; value ]
                  when String.lowercase_ascii name = "content-length" ->
                    Some (int_of_string (String.trim value))
                | _ -> None)
              headers
            |> Option.get
          in
          Alcotest.(check string)
            "each attempt receives the complete byte source" payload
            (Eio.Buf_read.take length input);
          Eio.Flow.copy_string
            (Printf.sprintf "HTTP/1.1 %d Probe\r\nContent-Length: 0\r\n\r\n"
               (if attempt = 1 then 503 else 200))
            flow
        done)
  in
  for attempt = 1 to 2 do
    Switch.run @@ fun sw ->
    let response, body =
      Cohttp_eio.Client.put http ~sw ~body:(open_body ())
        (Uri.of_string (Printf.sprintf "http://localhost:%d/upload" port))
    in
    Alcotest.(check int)
      "retry policy sees each actual response"
      (if attempt = 1 then 503 else 200)
      (Cohttp.Code.code_of_status (Cohttp.Response.status response));
    ignore (read_body body)
  done;
  Promise.await_exn peer;
  Alcotest.(check int)
    "body factory is reopened for each explicit attempt" 2 !opens;
  Alcotest.(check int) "no hidden attempt" 2 !connects

let tls ~trusted ~host () =
  Eio_main.run @@ fun env ->
  let certificate = value (X509.Certificate.decode_pem (pem "peer-cert.pem")) in
  let key = value (X509.Private_key.decode_pem (pem "peer-key.pem")) in
  let server_config =
    value (Tls.Config.server ~certificates:(`Single ([ certificate ], key)) ())
  in
  let time () = Ptime.of_float_s (Eio.Time.now (Eio.Stdenv.clock env)) in
  let authenticator =
    X509.Authenticator.chain_of_trust ~time
      (if trusted then [ certificate ] else [])
  in
  let config = value (Tls.Config.client ~authenticator ()) in
  with_listener env @@ fun sw socket address _ ->
  let server =
    Fiber.fork_promise ~sw (fun () ->
        Switch.run @@ fun sw ->
        let flow, _ = Eio.Net.accept ~sw socket in
        try
          let tls = Tls_eio.server_of_flow server_config flow in
          Eio.Flow.copy_string "authenticated" tls;
          Ok ()
        with
        | Tls_eio.Tls_alert alert -> Error (`Alert alert)
        | Tls_eio.Tls_failure failure -> Error failure)
  in
  let result =
    try
      Switch.run (fun sw ->
          let flow = Eio.Net.connect ~sw (Eio.Stdenv.net env) address in
          let tls =
            Tls_eio.client_of_flow config
              ~host:(Domain_name.host_exn (Domain_name.of_string_exn host))
              flow
          in
          Alcotest.(check string)
            "authenticated TLS bytes" "authenticated"
            Eio.Buf_read.(take 13 (of_flow ~max_size:1024 tls)));
      `Accepted
    with Tls_eio.Tls_failure (`Error (`AuthenticationFailure _)) -> `Refused
  in
  check "trust and hostname are both required"
    (trusted && host = "localhost")
    (result = `Accepted);
  let peer = Promise.await_exn server in
  if result = `Accepted then
    check "server also completed the authenticated handshake" true (peer = Ok ())

let payload_wire () =
  let module B = Semiont.Bus_registry in
  let module W = Semiont.Wire_stream in
  Eio_main.run @@ fun env ->
  with_listener env @@ fun sw socket address port ->
  let url = Uri.of_string (Printf.sprintf "http://localhost:%d/bus" port) in
  let body =
    Result.get_ok
      (W.encode_emit B.Channels.browse_resource_requested ~client_id:"client"
         ~correlation_id:"request" {|{"resourceId":"res-1"}|})
  in
  let frame id data =
    Printf.sprintf "event: %s\r\nid: %s\r\ndata: %s\r\n\r\n" B.stream_event id
      data
  in
  let stream =
    ": heartbeat\r\n\r\n"
    ^ frame "bad-frame"
        {|{"channel":"mark:archive-ok","correlationId":"request","payload":null,"scope":null}|}
    ^ frame "bad-payload"
        {|{"channel":"mark:archive-ok","payload":{"unexpected":true}}|}
    ^ frame "good"
        {|{"channel":"mark:archive-ok","correlationId":"request","payload":{}}|}
  in
  let server =
    Fiber.fork_promise ~sw (fun () ->
        let flow, _ = Eio.Net.accept ~sw socket in
        let _, _, input = request flow in
        Alcotest.(check string)
          "emitted JSON reaches peer" body
          (Eio.Buf_read.take (String.length body) input);
        Eio.Flow.copy_string
          (Printf.sprintf "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n%s"
             (String.length stream) stream)
          flow)
  in
  let http = client env address (ref 0) in
  let _, response =
    Cohttp_eio.Client.post http ~sw ~body:(Cohttp_eio.Body.of_string body) url
  in
  let input = Eio.Buf_read.of_flow ~max_size:65536 response in
  (match W.read input with
  | Some
      (Error
         (W.Invalid_frame (Some route, Semiont.Models.Invalid_payload fault)))
    ->
      Alcotest.(check (option string))
        "refusal keeps correlation" (Some "request") route.correlation_id;
      Alcotest.(check string) "frame fault names payload" "payload" fault.member
  | _ -> Alcotest.fail "expected routed frame refusal");
  (match W.read input with
  | Some (Ok (W.Frame { payload = Error (B.Invalid_payload fault); _ })) ->
      Alcotest.(check string)
        "payload fault names field" "unexpected" fault.member
  | _ -> Alcotest.fail "expected channel payload refusal");
  (match W.read input with
  | Some (Ok (W.Frame { id = Some "good"; payload = Ok payload; _ })) ->
      Alcotest.(check string) "next frame still decodes" "{}" (B.encode payload)
  | _ -> Alcotest.fail "expected decoded payload");
  check "end of response" true (Option.is_none (W.read input));
  Promise.await_exn server

let subscription_replay () =
  let module B = Semiont.Bus_registry in
  let module S = Semiont.Subscription in
  Eio_main.run @@ fun env ->
  with_listener env @@ fun sw socket address port ->
  let base = Eio_mock.Clock.Mono.make () in
  let jitter = Random.State.make [| 42 |] in
  let expected_delay =
    float Subscription_timing.reconnect_ms
    *. (0.5 +. (Random.State.float (Random.State.copy jitter) 1. *. 0.5))
  in
  let retry_at = Int64.of_float (expected_delay *. 1_000_000.) in
  let waiting, waiting_u = Promise.create () in
  let module Timer = struct
    type t = unit
    type time = Mtime.t

    let now () = Eio.Time.Mono.now base

    let sleep_until () due =
      if Mtime.to_uint64_ns due <= retry_at && not (Promise.is_resolved waiting)
      then Promise.resolve waiting_u ();
      Eio.Time.Mono.sleep_until base due
  end in
  let monotonic = Eio.Resource.T ((), Eio.Time.Pi.clock (module Timer)) in
  let clock =
    Semiont.Clock.make ~monotonic ~wall:(Eio.Stdenv.clock env) ~jitter
  in
  let sent, send = Promise.create () in
  let release, release_peer = Promise.create () in
  let reattached, attach = Promise.create () in
  let server =
    Fiber.fork_promise ~sw (fun () ->
        Switch.run (fun sw ->
            let flow, _ = Eio.Net.accept ~sw socket in
            ignore (request flow);
            Eio.Flow.copy_string "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n"
              flow;
            Promise.await sent);
        Switch.run (fun sw ->
            let flow, _ = Eio.Net.accept ~sw socket in
            ignore (request flow);
            let event =
              Printf.sprintf "event: %s\nid: reply-1\ndata: %s\n\n"
                B.stream_event
                {|{"channel":"mark:archive-ok","correlationId":"pending","payload":{}}|}
            in
            Eio.Flow.copy_string
              ("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n" ^ event ^ event)
              flow;
            Promise.await release))
  in
  let opens = ref 0 in
  let deliveries = ref 0 in
  let http = client env address (ref 0) in
  let connect ~sw snapshot =
    incr opens;
    if !opens = 2 then Promise.resolve attach snapshot;
    let body = Result.get_ok (S.encode_subscription snapshot) in
    let _, response =
      Cohttp_eio.Client.post http ~sw
        ~body:(Cohttp_eio.Body.of_string body)
        (Uri.of_string
           (Printf.sprintf "http://localhost:%d/bus/subscribe" port))
    in
    Ok (Eio.Buf_read.of_flow ~max_size:65536 response)
  in
  let subscription =
    S.start ~sw ~clock ~client_id:"client"
      ~global:
        [
          B.Channel B.Channels.mark_archive_ok;
          B.Channel B.Channels.mark_archive_failed;
        ]
      ~scopes:[] ~connect
      ~on_event:(fun _ -> incr deliveries)
      ()
  in
  let pending =
    Fiber.fork_promise ~sw (fun () ->
        S.request subscription ~correlation_id:"pending"
          B.Operations.mark_archive ~send:(fun () -> Promise.resolve send ()))
  in
  Promise.await waiting;
  check "drop leaves open" true (S.state subscription = S.Reconnecting);
  let before = Mtime.of_uint64_ns (Int64.pred retry_at) in
  let barrier =
    Fiber.fork_promise ~sw (fun () -> Eio.Time.Mono.sleep_until base before)
  in
  Eio_mock.Clock.Mono.set_time base before;
  Promise.await_exn barrier;
  Alcotest.(check int) "no early reconnect" 1 !opens;
  Eio_mock.Clock.Mono.set_time base (Mtime.of_uint64_ns retry_at);
  let snapshot = Promise.await reattached in
  Alcotest.(check (list string))
    "reopen carries unanswered id" [ "pending" ] snapshot.pending_replies;
  (match Promise.await_exn pending with
  | Ok (S.Result payload) ->
      Alcotest.(check string)
        "reply settles typed request" "{}" (B.encode payload)
  | _ -> Alcotest.fail "expected replayed reply");
  Alcotest.(check int) "replayed duplicate is suppressed" 1 !deliveries;
  let waiting_request () =
    let started, start = Promise.create () in
    let result =
      Fiber.fork_promise ~sw (fun () ->
          S.request subscription ~timeout_ms:20 ~correlation_id:"unused"
            B.Operations.mark_archive ~send:(fun () -> Promise.resolve start ()))
    in
    Promise.await started;
    result
  in
  let timed = waiting_request () in
  Eio_mock.Clock.Mono.set_time base
    (Mtime.of_uint64_ns (Int64.add retry_at 20_000_000L));
  check "unanswered request times out" true
    (Promise.await_exn timed = Error S.Timeout);
  let outstanding = waiting_request () in
  S.close subscription;
  S.await_closed subscription;
  check "close ends a pending request" true
    (Promise.await_exn outstanding = Error S.Transport_closed);
  check "close is terminal" true (S.state subscription = S.Closed);
  Promise.resolve release_peer ();
  Promise.await_exn server

let scope_handoff () =
  let module B = Semiont.Bus_registry in
  let module S = Semiont.Subscription in
  Eio_main.run @@ fun env ->
  Switch.run @@ fun sw ->
  let base = Eio_mock.Clock.Mono.make () in
  let timers = Eio.Stream.create 64 in
  let module Timer = struct
    type t = unit
    type time = Mtime.t

    let now () = Eio.Time.Mono.now base

    let sleep_until () due =
      Eio.Stream.add timers (Mtime.to_uint64_ns due);
      Eio.Time.Mono.sleep_until base due
  end in
  let monotonic = Eio.Resource.T ((), Eio.Time.Pi.clock (module Timer)) in
  let clock =
    Semiont.Clock.make ~monotonic ~wall:(Eio.Stdenv.clock env)
      ~jitter:(Random.State.make [| 0 |])
  in
  let module Source = struct
    type t = string Eio.Stream.t

    let read_methods = []

    let single_read chunks buffer =
      let chunk = Eio.Stream.take chunks in
      let length = String.length chunk in
      if length > Cstruct.length buffer then failwith "probe frame too large";
      Cstruct.blit_from_string chunk 0 buffer 0 length;
      length
  end in
  let openings = Eio.Stream.create 4 in
  let events = Eio.Stream.create 8 in
  let closed = ref [] in
  let opened = ref 0 in
  let first_read = Promise.create () in
  let connect ~sw snapshot =
    incr opened;
    let index = !opened in
    let chunks = Eio.Stream.create 8 in
    let resume, ready = Promise.create () in
    Eio.Switch.on_release sw (fun () -> closed := index :: !closed);
    Eio.Stream.add openings (snapshot, chunks, ready);
    Promise.await resume;
    let source = Eio.Resource.T (chunks, Eio.Flow.Pi.source (module Source)) in
    if index = 1 then Promise.resolve (snd first_read) ();
    Ok (Eio.Buf_read.of_flow ~max_size:65536 source)
  in
  let subscription =
    S.start ~sw ~clock ~client_id:"client"
      ~global:[ B.Channel B.Channels.mark_archive_ok ]
      ~scopes:[] ~connect
      ~on_event:(fun event -> Eio.Stream.add events event)
      ()
  in
  let _, original, open_original = Eio.Stream.take openings in
  Promise.resolve open_original ();
  Promise.await (fst first_read);
  let publish chunks id =
    Eio.Stream.add chunks
      (Printf.sprintf "event: %s\nid: %s\ndata: %s\n\n" B.stream_event id
         {|{"channel":"mark:archive-ok","payload":{}}|})
  in
  let read id =
    match Eio.Stream.take events with
    | Ok (Semiont.Wire_stream.Frame { id = Some actual; _ }) ->
        Alcotest.(check string) "event delivered once" id actual
    | _ -> Alcotest.fail "expected event"
  in
  publish original "first";
  read "first";
  let scope =
    {
      S.resource =
        Result.get_ok (Semiont.Identifiers.Resource_id.of_string "res-1");
      channels = [ B.Channel B.Channels.mark_removed ];
    }
  in
  let release = S.hold_scope subscription scope in
  let release_second = S.hold_scope subscription scope in
  release ();
  let nanos ms = Int64.mul (Int64.of_int ms) 1_000_000L in
  let rec await_timer due =
    if Eio.Stream.take timers <> due then await_timer due
  in
  let tick due =
    let time = Mtime.of_uint64_ns due in
    let barrier =
      Fiber.fork_promise ~sw (fun () -> Eio.Time.Mono.sleep_until base time)
    in
    Eio_mock.Clock.Mono.set_time base time;
    Promise.await_exn barrier
  in
  let handoff_at = nanos Subscription_timing.reconnect_debounce_ms in
  await_timer handoff_at;
  tick (Int64.pred handoff_at);
  Alcotest.(check int) "addition is debounced" 1 !opened;
  tick handoff_at;
  let replacement, successor, open_successor = Eio.Stream.take openings in
  check "remaining hold is included" true (List.length replacement.scoped = 1);
  publish original "while-opening";
  read "while-opening";
  check "handoff stays open" true (S.state subscription = S.Open);
  Promise.resolve open_successor ();
  let retire_at = Int64.add handoff_at (nanos Subscription_timing.linger_ms) in
  await_timer retire_at;
  publish original "overlap";
  read "overlap";
  publish successor "overlap";
  publish successor "successor";
  read "successor";
  let positioned id =
    Eio.Stream.add successor
      (Printf.sprintf "event: %s\nid: %s\ndata: %s\n\n" B.stream_event id
         {|{"channel":"mark:removed","scope":"res-1","payload":{"id":"event","type":"mark:removed","timestamp":"2026-11-07","userId":"did:web:example:alice","version":1,"payload":{"annotationId":"a-1"},"metadata":{"sequenceNumber":10}}}|})
  in
  positioned "p-res-1-10";
  read "p-res-1-10";
  positioned "p-res-1-9";
  read "p-res-1-9";
  tick (Int64.pred retire_at);
  check "old body still open before linger" true (not (List.mem 1 !closed));
  tick retire_at;
  let removal_at =
    Int64.add retire_at (nanos Subscription_timing.lazy_remove_ms)
  in
  release_second ();
  release_second ();
  await_timer removal_at;
  tick (Int64.pred removal_at);
  Alcotest.(check int) "removal waits for lazy removal" 2 !opened;
  tick removal_at;
  let final, _, open_final = Eio.Stream.take openings in
  check "last release removes scope" true (final.scoped = []);
  check "old body closes at handoff" true (List.mem 1 !closed);
  Promise.resolve open_final ();
  let release_again = S.hold_scope subscription scope in
  let rejoin_at =
    Int64.add removal_at (nanos Subscription_timing.reconnect_debounce_ms)
  in
  await_timer rejoin_at;
  tick rejoin_at;
  let rejoined, _, open_rejoined = Eio.Stream.take openings in
  check "scope resumes at its highest position" true
    (List.map snd rejoined.scoped = [ Some "p-res-1-10" ]);
  Promise.resolve open_rejoined ();
  release_again ();
  S.close subscription;
  S.await_closed subscription;
  Alcotest.(check (list int))
    "every body released" [ 1; 2; 3; 4 ]
    (List.sort Int.compare !closed)

let credential_renewal () =
  let module S = Semiont.Subscription in
  Eio_main.run @@ fun _ ->
  Switch.run @@ fun sw ->
  let current = ref (Some "first") in
  let attempted = ref [] in
  let refusals = ref [] in
  let renewals = ref [] in
  let dropped = ref false in
  let connect ~sw:_ _ ~bearer =
    attempted := bearer :: !attempted;
    match bearer with
    | "first" -> Error (S.Credential_refused 401)
    | "second" when not !dropped ->
        dropped := true;
        Error S.Connect_failed
    | "second" -> Error (S.Credential_refused 429)
    | _ -> Ok (Eio.Buf_read.of_string "")
  in
  let open_stream =
    S.authenticated
      ~credential:(fun () -> !current)
      ~renew:(fun ~refused ->
        renewals := refused :: !renewals;
        current := Some "second";
        !current)
      ~on_refused:(fun status -> refusals := status :: !refusals)
      connect
  in
  let snapshot =
    { S.client_id = "client"; global = []; scoped = []; pending_replies = [] }
  in
  check "transient drop retries with the same replacement" true
    (open_stream ~sw snapshot = Error S.Retry);
  check "second refusal stops immediately" true
    (open_stream ~sw snapshot = Error S.No_credential);
  check "refused bearer is not sent again" true
    (open_stream ~sw snapshot = Error S.No_credential);
  Alcotest.(check (list string))
    "retry keeps the replacement"
    [ "second"; "second"; "first" ]
    !attempted;
  Alcotest.(check (list string))
    "renewal names the refused token" [ "first" ] !renewals;
  Alcotest.(check (list int))
    "both refused statuses reported" [ 429; 401 ] !refusals;
  current := Some "new";
  check "a different credential can connect" true
    (Result.is_ok (open_stream ~sw snapshot))

let () =
  Mirage_crypto_rng_unix.use_default ();
  Alcotest.run "OCaml native transport substrate"
    [
      ( "http",
        [
          Alcotest.test_case "explicit connection and redirect policy" `Quick
            explicit_connection_policy;
          Alcotest.test_case "wire codecs over loopback HTTP" `Quick
            payload_wire;
          Alcotest.test_case "controlled reconnect replays pending replies"
            `Quick subscription_replay;
          Alcotest.test_case "scope holds hand off and linger" `Quick
            scope_handoff;
          Alcotest.test_case "credential renewal stops on second refusal" `Quick
            credential_renewal;
          Alcotest.test_case "no hidden retry" `Quick no_hidden_retry;
          Alcotest.test_case "request scopes preserve a borrowed connection"
            `Quick borrowed_connection;
          Alcotest.test_case "replay the complete upload source" `Quick
            replayable_upload;
          Alcotest.test_case "deliberately early timer is refused" `Quick
            early_timer_refused;
          Alcotest.test_case "controlled header deadline" `Quick
            (controlled_deadline Headers);
          Alcotest.test_case "controlled body deadline" `Quick
            (controlled_deadline Body);
          Alcotest.test_case "controlled TLS attachment deadline" `Quick
            (controlled_deadline Handshake);
        ] );
      ( "tls",
        [
          Alcotest.test_case "trusted hostname" `Quick
            (tls ~trusted:true ~host:"localhost");
          Alcotest.test_case "wrong hostname" `Quick
            (tls ~trusted:true ~host:"elsewhere.example");
          Alcotest.test_case "untrusted issuer" `Quick
            (tls ~trusted:false ~host:"localhost");
        ] );
    ]
