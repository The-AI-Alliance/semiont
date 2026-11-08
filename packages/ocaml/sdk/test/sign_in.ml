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
          ~refused:(Some "old")
        = Session.Renewed (token "first"));
      assert (
        Store.renew store ~key
          ~refused:(Some (token "first"))
          ~http:(fun _ ->
            save "other-writer";
            token_response "discarded")
        = Session.Renewed (token "other-writer"));
      assert (
        Store.renew store ~key
          ~refused:(Some (token "other-writer"))
          ~http:(fun _ ->
            Store.remove store ~key;
            token_response "discarded")
        = Session.Refused);
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
            ~refused:(optional "holding" row)
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

let () =
  Alcotest.run "OCaml sign-in"
    [
      ("OAuth", [ Alcotest.test_case "redirect state and PKCE" `Quick pkce ]);
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
