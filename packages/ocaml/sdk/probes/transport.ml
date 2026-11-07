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
