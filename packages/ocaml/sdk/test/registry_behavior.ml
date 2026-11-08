open Eio.Std
open Semiont
module R = Registry
module D = Discovery
module J = Yojson.Safe.Util

let field = J.member
let string name value = J.to_string (field name value)
let int name value = J.to_int (field name value)
let rows name value = J.to_list (field name value)
let text value = `String value

let decode schema value =
  Result.get_ok (Models.decode schema (Yojson.Safe.to_string value))

(* Shared origin and ordering rows from session/registry-cases.json. *)
let shared () =
  let table = Yojson.Safe.from_string Registry_cases.cases in
  List.iter
    (fun row ->
      let read name = decode Models.kb_endpoint (field name row) in
      Alcotest.(check bool)
        (string "why" row)
        (J.to_bool (field "samePlace" row))
        (R.same_place (read "one") (read "other")))
    (rows "cases" table);
  List.iter
    (fun row ->
      let open_resource value : R.open_resource =
        let optional name =
          match field name value with `String text -> Some text | _ -> None
        in
        {
          id = string "id" value;
          name = string "name" value;
          opened_at = int "openedAt" value;
          order = int "order" value;
          media_type = optional "mediaType";
          storage_uri = optional "storageUri";
        }
      in
      let shown =
        R.sort_open_resources (List.map open_resource (rows "open" row))
      in
      Alcotest.(check (list string))
        (string "why" row)
        (List.map J.to_string (rows "shown" row))
        (List.map (fun (tab : R.open_resource) -> tab.id) shown))
    (rows "openResourceOrder" table)

let discovery () =
  let parse = D.parse_discovery_document in
  assert (parse {|{"version":1,"kbs":[]}|} = D.Managed []);
  assert (parse {|{"version":2,"kbs":[]}|} = D.Absent D.Unsupported_version);
  assert (parse "html" = D.Absent D.Not_json);
  assert (parse {|{"version":1,"kbs":[{}]}|} = D.Absent D.Invalid);
  let entry port name =
    Printf.sprintf
      {|{"host":"localhost","port":%d,"did":"did:web:kb.example","managedBy":"semiont-launcher","placement":"local","siteName":"%s"}|}
      port name
  in
  let document entries =
    parse ("{\"version\":1,\"kbs\":[" ^ String.concat "," entries ^ "]}")
  in
  let a = entry 4010 "Local" and b = entry 4011 "Forward" in
  assert (D.discovery_diff (Some (document [ a; b ])) (document [ b; a ]) = None);
  let changed =
    Option.get
      (D.discovery_diff
         (Some (document [ a; b ]))
         (document [ entry 4010 "New"; a ]))
  in
  assert (List.length changed.updated = 2);
  assert (List.length changed.removed = 1);
  assert (changed.duplicated = [ ("localhost", 4010) ]);
  assert (D.text_discovery (fun () -> None) () = D.Read (D.Absent D.Not_found))

(* Discovery and deviceGrant rows from client/clock-cases.json. *)
let controlled () =
  let table = Yojson.Safe.from_string Registry_cases.clock_cases |> J.to_list in
  let timing = Yojson.Safe.from_string Registry_cases.timing in
  let number fallback = function
    | `Int n -> float n
    | `Float n -> n
    | _ -> fallback
  in
  let elapsed = function
    | `Int elapsed -> elapsed
    | value ->
        let base = string "timing" value |> fun name -> int name timing in
        int_of_float
          ((float base *. number 1. (field "times" value))
          +. number 0. (field "plusMs" value))
  in
  List.iter
    (fun row ->
      Eio_mock.Backend.run @@ fun () ->
      Switch.run @@ fun sw ->
      let mono = Eio_mock.Clock.Mono.make () in
      let wall = Eio_mock.Clock.make () in
      let clock =
        Clock.make ~monotonic:mono ~wall ~jitter:(Random.State.make [| 1 |])
      in
      let count = ref 0 in
      (match string "subject" row with
      | "discovery" ->
          let _release =
            D.subscribe_discovery ~sw ~clock
              (fun () ->
                incr count;
                if !count = 1 then D.Read (D.Managed []) else D.Unchanged)
              ~on_change:ignore
          in
          ()
      | "deviceGrant" ->
          let given = field "given" row in
          let endpoint = "https://issuer.example/token" in
          let issuer =
            Result.get_ok
              (OAuth.discover ~issuer:"https://issuer.example" (fun _ ->
                   ( 200,
                     {|{"issuer":"https://issuer.example","authorization_endpoint":"https://issuer.example/auth","token_endpoint":"https://issuer.example/token","device_authorization_endpoint":"https://issuer.example/device"}|}
                   )))
          in
          let fields =
            [
              ("device_code", text "device");
              ("user_code", text "USER");
              ("verification_uri", text "https://issuer.example/verify");
              ("expires_in", `Int 900);
            ]
          in
          let fields =
            match field "intervalSeconds" given with
            | `Int n -> ("interval", `Int n) :: fields
            | _ -> fields
          in
          let device =
            Result.get_ok
              (OAuth.begin_device
                 (fun _ -> (200, Yojson.Safe.to_string (`Assoc fields)))
                 issuer)
          in
          let errors = rows "answers" given in
          Fiber.fork_daemon ~sw (fun () ->
              ignore
                (OAuth.await_device ~clock
                   (fun (request : OAuth.request) ->
                     assert (request.url = endpoint);
                     let code =
                       List.nth errors (min !count (List.length errors - 1))
                     in
                     incr count;
                     (400, Yojson.Safe.to_string (`Assoc [ ("error", code) ])))
                   issuer device);
              `Stop_daemon)
      | _ -> assert false);
      let settle () =
        for _ = 1 to 6 do
          Fiber.yield ()
        done
      in
      settle ();
      List.iter
        (fun step ->
          match field "counted" step with
          | `Int expected ->
              Alcotest.(check int) (string "case" row) expected !count
          | _ ->
              let elapsed = elapsed (field "pass" step) in
              Eio_mock.Clock.Mono.set_time mono
                (Option.get
                   (Mtime.add_span
                      (Clock.monotonic_now clock)
                      Mtime.Span.(elapsed * ms)));
              settle ())
        (rows "steps" row))
    table

let sign_in () =
  Eio_main.run @@ fun env ->
  let clock =
    Clock.make
      ~monotonic:(Eio.Stdenv.mono_clock env)
      ~wall:(Eio.Stdenv.clock env)
      ~jitter:(Random.State.make [| 1 |])
  in
  let values = Hashtbl.create 8 in
  let storage : R.storage =
    {
      read = Hashtbl.find_opt values;
      write = Hashtbl.replace values;
      remove = Hashtbl.remove values;
    }
  in
  let serial = ref 0 in
  let browser =
    R.new_semiont_browser
      {
        storage;
        clock;
        fresh_id =
          (fun () ->
            incr serial;
            "kb-" ^ string_of_int !serial);
        factory = (fun _ -> assert false);
        on_error = ignore;
      }
  in
  let endpoint port =
    decode Models.kb_endpoint
      (`Assoc
         [
           ("kind", text "http");
           ("host", text "localhost");
           ("port", `Int port);
           ("protocol", text "http");
         ])
  in
  let description domain =
    decode Models.kb_description
      (`Assoc [ ("name", text domain); ("domain", text domain) ])
  in
  let sign port domain access =
    Result.get_ok
      (R.record_sign_in browser
         {
           endpoint = endpoint port;
           description = description domain;
           session =
             {
               access;
               refresh = "refresh";
               client_id = "script";
               token_endpoint = "https://issuer.example/token";
               revocation_endpoint = None;
             };
           kb_id = Some "kb-1";
           expected_did = Some "did:web:one.example";
           expected_name = None;
         })
  in
  let id (outcome : R.sign_in_outcome) =
    (Records.Knowledge_base.of_model outcome.kb).id
  in
  assert (id (sign 4010 "one.example" "first") = "kb-1");
  assert (id (sign 4010 "one.example" "new") = "kb-1");
  assert (id (sign 4011 "one.example" "different-address") = "kb-2");
  assert (id (sign 4010 "other.example" "different-identity") = "kb-3");
  assert ((Option.get (R.stored_session storage "kb-1")).access = "new");
  R.sign_out browser "kb-3";
  assert (R.active_id browser = None && R.stored_session storage "kb-3" = None)

let () =
  Alcotest.run "OCaml registry and discovery"
    [
      ( "registry",
        [
          Alcotest.test_case "shared cases" `Quick shared;
          Alcotest.test_case "verified sign-in" `Quick sign_in;
        ] );
      ( "discovery",
        [
          Alcotest.test_case "document and diff" `Quick discovery;
          Alcotest.test_case "shared clock" `Quick controlled;
        ] );
    ]
