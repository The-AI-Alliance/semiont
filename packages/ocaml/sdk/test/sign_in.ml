open Semiont
module O = OAuth
module Store = Sign_in_store

let issuer_url = "https://issuer.example/realm"
let endpoint = issuer_url ^ "/token"
let get = function Ok value -> value | Error _ -> failwith "OAuth error"
let json fields = Yojson.Safe.to_string (`Assoc fields)
let str value = `String value

let issuer () =
  O.discover ~issuer:issuer_url (fun (request : O.request) ->
      assert (request.meth = "GET");
      assert (request.url = issuer_url ^ "/.well-known/openid-configuration");
      ( 200,
        json
          [
            ("issuer", str issuer_url);
            ("authorization_endpoint", str (issuer_url ^ "/auth"));
            ("token_endpoint", str endpoint);
            ("device_authorization_endpoint", str (issuer_url ^ "/device"));
            ("revocation_endpoint", str (issuer_url ^ "/revoke"));
          ] ))
  |> get

let pkce () =
  let issuer = issuer () in
  let next = ref 0 in
  let random count =
    incr next;
    String.make count (Char.chr !next)
  in
  let redirect_uri = "http://localhost:4000/callback" in
  let redirect = O.begin_redirect issuer ~random ~redirect_uri in
  let uri = Uri.of_string (O.url redirect) in
  let param key = Option.get (Uri.get_query_param uri key) in
  let callback state = redirect_uri ^ "?code=abc&state=" ^ state in
  let calls = ref 0 in
  let http (request : O.request) =
    incr calls;
    assert (request.url = endpoint);
    assert (List.assoc "client_id" request.form = "semiont-browser");
    assert (
      List.assoc "code_verifier" request.form
      = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE");
    (200, {|{"access_token":"access"}|})
  in
  assert (
    O.finish_redirect http issuer redirect ~callback:(callback "wrong")
    = Error O.Invalid_redirect);
  assert (!calls = 0);
  assert (
    (get
       (O.finish_redirect http issuer redirect
          ~callback:(callback (param "state"))))
      .access_token = "access");
  assert (!calls = 1)

let token label =
  "header."
  ^ Base64.encode_exn ~pad:false ~alphabet:Base64.uri_safe_alphabet
      (json
         [
           ("iss", str issuer_url);
           ("email", str "test@example.org");
           ("jti", str label);
         ])
  ^ ".signature"

let token_response label =
  ( 200,
    json
      [
        ("access_token", str (token label));
        ("refresh_token", str ("refresh-" ^ label));
        ("expires_in", `Int 3600);
      ] )

let store () =
  Eio_main.run @@ fun env ->
  let directory = Filename.temp_file "semiont-sign-in" "" in
  Unix.unlink directory;
  Unix.mkdir directory 0o700;
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Unix.unlink (Filename.concat directory name))
        (Sys.readdir directory);
      Unix.rmdir directory)
    (fun () ->
      let clock =
        Clock.make ~wall:(Eio.Stdenv.clock env)
          ~monotonic:(Eio.Stdenv.mono_clock env)
          ~jitter:(Random.State.make [| 1 |])
      in
      let store = Store.make ~clock ~directory in
      let issuer = issuer () in
      let key = "local:example.org" in
      let device =
        get
          (O.begin_device
             (fun _ ->
               ( 200,
                 {|{"device_code":"device","user_code":"USER","verification_uri":"https://issuer.example/verify","expires_in":30}|}
               ))
             issuer)
      in
      let path = Filename.concat directory "tokens.json" in
      Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_excl ]
        0o600 path (fun file ->
          output_string file {|{"future":{"newField":true}}|});
      let save label =
        get
          (Store.save_device store ~key ~issuer
             (get (O.poll_device (fun _ -> token_response label) issuer device)))
      in
      save "first";
      assert ((Unix.stat path).st_perm = 0o600);
      assert (
        (Unix.stat (Filename.concat directory "tokens.lock")).st_perm = 0o600);
      assert (
        Store.renew store ~key
          ~http:(fun _ -> assert false)
          ~holding:(Some "old")
        = Session.Renewed (token "first"));
      assert (
        Store.renew store ~key
          ~holding:(Some (token "first"))
          ~http:(fun _ ->
            save "other-writer";
            token_response "discarded")
        = Session.Renewed (token "other-writer"));
      assert (
        Store.renew store ~key
          ~holding:(Some (token "other-writer"))
          ~http:(fun _ ->
            Store.remove store ~key;
            token_response "discarded")
        = Session.Refused);
      assert (Store.find store ~key = None);
      save "for-revocation";
      assert (
        Store.sign_out store ~key ~http:(fun request ->
            assert (Store.find store ~key = None);
            assert (List.assoc "token" request.O.form = "refresh-for-revocation");
            (500, ""))
        = Error (O.Rejected "oauth.revocation-failed"));
      assert (Store.find store ~key = None);
      assert (
        Yojson.Safe.from_file path
        = `Assoc [ ("future", `Assoc [ ("newField", `Bool true) ]) ]))

let field = Yojson.Safe.Util.member
let optional = function `String value -> Some value | _ -> None
let get_text name value = Option.get (optional (field name value))

(* Shared rows from sign-in-store/cases.json. *)
let paths () =
  Yojson.Safe.from_string Sign_in_cases.cases
  |> Yojson.Safe.Util.to_list
  |> List.iter (fun row ->
      let platform =
        match get_text "os" row with
        | "macos" -> Store.Macos
        | "windows" -> Store.Windows
        | _ -> Store.Other
      in
      let optional name = optional (field name row) in
      let actual =
        Store.state_directory ~platform ~home:(optional "home")
          ~xdg_state_home:(optional "xdgStateHome")
          ~local_app_data:(optional "localAppData")
      in
      Alcotest.(check (option string))
        (get_text "why" row) (optional "dir") actual)

let renewals () =
  Eio_main.run @@ fun env ->
  let clock =
    Clock.make ~wall:(Eio.Stdenv.clock env)
      ~monotonic:(Eio.Stdenv.mono_clock env)
      ~jitter:(Random.State.make [| 1 |])
  in
  let run row =
    let dir = Filename.temp_file "semiont-renewal" "" in
    Unix.unlink dir;
    Unix.mkdir dir 0o700;
    let file = Filename.concat dir "tokens.json" in
    Fun.protect
      ~finally:(fun () ->
        Array.iter
          (fun name -> Unix.unlink (Filename.concat dir name))
          (Sys.readdir dir);
        Unix.rmdir dir)
      (fun () ->
        let why = get_text "why" row in
        let optional name value = optional (field name value) in
        let expired = Yojson.Safe.Util.to_list (field "expired" row) in
        let write entry =
          let entries =
            match entry with
            | `Null -> []
            | `Assoc fields ->
                let is_expired = List.mem (field "token" entry) expired in
                [
                  ( "local:test",
                    `Assoc
                      (fields
                      @ [
                          ("issuer", str issuer_url);
                          ("tokenEndpoint", str endpoint);
                          ("obtainedAt", str "2026-01-01T00:00:00Z");
                          ( "expiresAt",
                            str
                              (if is_expired then "2000-01-01T00:00:00Z"
                               else "2099-01-01T00:00:00Z") );
                        ]) );
                ]
            | _ -> assert false
          in
          Out_channel.with_open_gen [ Open_wronly; Open_creat; Open_trunc ]
            0o600 file (fun stream -> output_string stream (json entries))
        in
        write (field "kept" row);
        let meanwhile when_ =
          let action = field "meanwhile" row in
          match action with
          | `Assoc _ when optional "when" action = Some when_ ->
              write (field "theirs" action)
          | _ -> ()
        in
        meanwhile "before";
        let store = Store.make ~clock ~directory:dir in
        let spent = ref [] in
        let http (request : O.request) =
          spent := List.assoc "refresh_token" request.form :: !spent;
          meanwhile "during";
          let issued = field "issues" row in
          ( 200,
            json
              (("access_token", field "token" issued)
              :: Option.to_list
                   (Option.map
                      (fun value -> ("refresh_token", str value))
                      (optional "refreshToken" issued))) )
        in
        let actual =
          Store.renew store ~key:"local:test" ~http
            ~holding:(optional "holding" row)
        in
        let actual =
          match actual with
          | Session.Renewed value -> Some value
          | Session.Refused -> None
          | Session.Unavailable -> failwith why
        in
        Alcotest.(check (option string)) why (optional "gives" row) actual;
        Alcotest.(check (list string))
          why
          (Option.to_list (optional "spends" row))
          !spent;
        let document = Yojson.Safe.from_file file in
        let kept = field "local:test" document in
        let leaves = field "leaves" row in
        let credentials = function
          | `Null -> None
          | value -> Some (get_text "token" value, optional "refreshToken" value)
        in
        Alcotest.(check (option (pair string (option string))))
          why (credentials leaves) (credentials kept))
  in
  Yojson.Safe.from_string Sign_in_cases.renewals
  |> Yojson.Safe.Util.to_list |> List.iter run

(* Shared rows from session/client-assertion-cases.json. *)
let rsa () =
  Eio_main.run @@ fun env ->
  Mirage_crypto_rng_unix.use_default ();
  let pem =
    In_channel.with_open_bin "../probes/peer-key.pem" In_channel.input_all
  in
  let key = get (O.rsa_key_of_pem pem) in
  let public =
    X509.Private_key.public (get (X509.Private_key.decode_pem pem))
  in
  let vector = Yojson.Safe.from_string Assertion_cases.cases in
  let list = Yojson.Safe.Util.to_list in
  let thumbprint jwk =
    O.rsa_thumbprint ~e:(get_text "e" jwk) ~n:(get_text "n" jwk)
  in
  List.iter
    (fun row ->
      assert (thumbprint (field "jwk" row) = get_text "thumbprint" row))
    (list (field "thumbprints" vector));
  List.iter
    (fun row ->
      let token_endpoint = get_text "tokenEndpoint" row in
      let issuer =
        get
          (O.discover ~issuer:issuer_url (fun _ ->
               ( 200,
                 json
                   [
                     ("issuer", str issuer_url);
                     ("authorization_endpoint", str (issuer_url ^ "/auth"));
                     ("token_endpoint", str token_endpoint);
                   ] )))
      in
      let issued_at = Yojson.Safe.Util.to_int (field "issuedAt" row) in
      let wall = Eio_mock.Clock.make () in
      Eio_mock.Clock.set_time wall (float issued_at);
      let clock =
        Clock.make ~wall
          ~monotonic:(Eio.Stdenv.mono_clock env)
          ~jitter:(Random.State.make [| 1 |])
      in
      let decode value =
        get (Base64.decode ~pad:false ~alphabet:Base64.uri_safe_alphabet value)
      in
      let http (request : O.request) =
        assert (request.url = token_endpoint);
        let keys = List.map fst request.form in
        assert (
          keys
          = List.map Yojson.Safe.Util.to_string (list (field "form" vector)));
        assert (
          List.assoc "grant_type" request.form = get_text "grantType" vector);
        assert (
          List.assoc "client_assertion_type" request.form
          = get_text "assertionType" vector);
        (match
           String.split_on_char '.' (List.assoc "client_assertion" request.form)
         with
        | [ header; claims; signature ] ->
            let message = header ^ "." ^ claims in
            assert (
              Result.is_ok
                (X509.Public_key.verify `SHA256 ~scheme:`RSA_PKCS1
                   ~signature:(decode signature) public (`Message message)));
            let header = Yojson.Safe.from_string (decode header) in
            let expected_header = field "header" row in
            assert (get_text "alg" header = get_text "alg" expected_header);
            assert (
              get_text "kid" expected_header = thumbprint (field "jwk" row));
            assert (String.length (get_text "kid" header) = 43);
            let sort = List.sort compare in
            assert (
              sort
                (Yojson.Safe.Util.to_assoc
                   (Yojson.Safe.from_string (decode claims)))
              = sort (Yojson.Safe.Util.to_assoc (field "claims" row)))
        | _ -> assert false);
        (200, {|{"access_token":"rsa-token"}|})
      in
      assert (
        (get
           (O.service_key http issuer ~clock
              ~jti:(fun () -> get_text "jti" row)
              ~client_id:(get_text "clientId" row) ~key))
          .access_token = "rsa-token"))
    (list (field "cases" vector))

let revoke () =
  let http (request : O.request) =
    assert (request.url = issuer_url ^ "/revoke");
    assert (request.meth = "POST");
    assert (List.assoc "client_id" request.form = "semiont-cli");
    assert (List.assoc "token_type_hint" request.form = "refresh_token");
    assert (List.assoc "token" request.form = "kept");
    (200, "")
  in
  assert (
    O.revoke_script http ~revocation_endpoint:(issuer_url ^ "/revoke")
      ~refresh_token:"kept"
    = Ok ())

let agent () =
  Eio_main.run @@ fun env ->
  Eio.Switch.run @@ fun sw ->
  let clock =
    Clock.make ~wall:(Eio.Stdenv.clock env)
      ~monotonic:(Eio.Stdenv.mono_clock env)
      ~jitter:(Random.State.make [| 3 |])
  in
  let did = "did:web:kb.example:agents:worker" in
  let grants = ref 0 in
  let http (request : O.request) =
    incr grants;
    assert (request.url = endpoint);
    assert (List.assoc "client_secret" request.form = "secret");
    match !grants with
    | 1 -> (200, {|{"access_token":"initial"}|})
    | 2 -> (503, {|{"error":"unavailable"}|})
    | _ -> (200, {|{"access_token":"replacement"}|})
  in
  let call ~sw:_ ~meth ~path ~headers ~body:_ ~progress:_ =
    assert (meth = "GET" && path = "/api/users/me");
    assert (List.assoc "authorization" headers = "Bearer initial");
    let identity =
      json
        [
          ("did", str did);
          ("domain", str "kb.example");
          ("email", `Null);
          ("name", `Null);
          ("image", `Null);
        ]
    in
    (200, [], Eio.Flow.string_source identity)
  in
  let agent =
    get
      (Agent.sign_in ~sw ~clock ~issuer:(issuer ()) ~http ~client_id:"worker"
         ~proof:(Agent.Secret "secret")
         ~key:(fun () -> "unique")
         ~call ())
  in
  assert (Identifiers.User_id.to_string (Agent.did agent) = did);
  let session = Agent.session agent in
  assert (Session.refresh_refused session ~refused:"initial" = None);
  assert (Session.credential session = Some "initial");
  assert (
    Session.refresh_refused session ~refused:"initial" = Some "replacement");
  Agent.close agent

let () =
  Alcotest.run "OCaml sign-in"
    [
      ( "OAuth",
        [
          Alcotest.test_case "redirect state and PKCE" `Quick pkce;
          Alcotest.test_case "RSA assertion and thumbprint" `Quick rsa;
          Alcotest.test_case "issuer revocation form" `Quick revoke;
          Alcotest.test_case "agent identity and renewal" `Quick agent;
        ] );
      ( "shared store",
        [
          Alcotest.test_case "state paths" `Quick paths;
          Alcotest.test_case "renewal interleavings" `Quick renewals;
        ] );
      ( "store",
        [
          Alcotest.test_case "permissions, concurrent update and sign-out"
            `Quick store;
        ] );
    ]
