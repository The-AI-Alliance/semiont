open Semiont
module J = Yojson.Safe.Util

let field = J.member
let text name row = J.to_string (field name row)
let rows source name = Yojson.Safe.from_string source |> field name |> J.to_list
let check = Alcotest.(check string)
let named row = text "why" row
let json = Yojson.Safe.to_string

(* Shared bus/log-cases.json. Exercise the emitted line, including nested redaction. *)
let log row =
  let payload = field "payload" row in
  let channel =
    Option.value (J.to_string_option (field "channel" row)) ~default:"test"
  in
  let prefix = "[bus EMIT] " ^ channel ^ " " in
  let line = Bus_log.line "EMIT" ~channel payload in
  check (named row) (prefix ^ json (field "shown" row)) line

(* Shared kb-identity/cases.json. An SDK derives identity from a domain
   declared by the gateway, as distinct from reading the launcher's YAML. *)
let kb row =
  let domain = text "domain" row in
  check "DID" (text "did" row) (Identity.knowledge_base_did domain);
  check "audience" (text "resource" row) (Identity.resource domain)

(* Shared principals/cases.json. *)
let principal kind row =
  check (named row) (text "did" row)
    (Identity.principal ~domain:(text "domain" row) ~kind (text "subject" row))

(* Shared media-types/cases.json. *)
let clone row =
  check (named row) (text "format" row)
    (Media_types.clone_format
       (Option.value (J.to_string_option (field "source" row)) ~default:""))

let filename row =
  check (named row) (text "fileName" row)
    (Media_types.storage_file_name ~name:(text "name" row)
       ~format:(text "format" row))

let text_source row =
  let format = text "format" row in
  let source =
    match Media_types.text_source format with
    | Decode -> "decode"
    | Pdf_text_layer -> "pdf-text-layer"
    | No_text -> "none"
  in
  check "source" (text "textSource" row) source;
  Alcotest.(check bool)
    "geometry"
    (J.to_bool (field "yieldsGeometry" row))
    (Media_types.yields_geometry format);
  Alcotest.(check bool)
    "derived"
    (J.to_bool (field "derivesText" row))
    (Media_types.derives_text format)

let bytes hex =
  String.split_on_char ' ' hex
  |> List.filter (fun byte -> byte <> "")
  |> List.map (fun byte ->
      String.make 1 (Char.chr (int_of_string ("0x" ^ byte))))
  |> String.concat ""

let decode ~content_type data =
  match Text_encoding.decode ~content_type data with
  | Ok value -> `String value
  | Error (Unsupported_charset name | Unsupported_media_type name) ->
      `Assoc [ ("refused", `String name) ]

(* Shared text/decode-cases.json. *)
let decode_case row =
  let expected =
    match field "refused" row with
    | `String _ as refused -> `Assoc [ ("refused", refused) ]
    | _ -> field "text" row
  in
  check (named row) (json expected)
    (json
       (decode ~content_type:(text "contentType" row)
          (bytes (text "bytes" row))))

(* Shared text/encoding-cases.json. Exercise every spelling and every byte. *)
let encoding row =
  List.iter
    (fun label ->
      let label = J.to_string label in
      let data, expected =
        match (field "everyByte" row, field "refused" row) with
        | (`String _ as text), _ -> (String.init 256 Char.chr, text)
        | _, `Bool true -> ("sample", `Assoc [ ("refused", `String label) ])
        | _ -> (bytes (text "bytes" row), field "text" row)
      in
      let content_type =
        "text/plain; charset=\" " ^ String.uppercase_ascii label ^ "\t\""
      in
      check label (json expected) (json (decode ~content_type data)))
    (field "labels" row |> J.to_list)

let cases rows run =
  List.map
    (fun row -> Alcotest.test_case (named row) `Quick (fun () -> run row))
    rows

let () =
  let open Closure_cases in
  let kb_rows =
    rows table_1 "cases" |> List.filter (fun row -> field "domain" row <> `Null)
  in
  let encodings =
    rows table_5 "cases"
    |> List.map (fun row ->
        Alcotest.test_case (text "encoding" row) `Quick (fun () -> encoding row))
  in
  Alcotest.run "OCaml remaining shared tables"
    [
      ("bus logs", cases (rows table_0 "cases") log);
      ("knowledge base identity", cases kb_rows kb);
      ("clone formats", cases (rows table_2 "cloneFormat") clone);
      ("storage filenames", cases (rows table_2 "storageFileName") filename);
      ("text sources", cases (rows table_2 "textSource") text_source);
      ("people", cases (rows table_3 "people") (principal Identity.Person));
      ("agents", cases (rows table_3 "agents") (principal Identity.Agent));
      ("decode", cases (rows table_4 "cases") decode_case);
      ("encodings", encodings);
    ]
