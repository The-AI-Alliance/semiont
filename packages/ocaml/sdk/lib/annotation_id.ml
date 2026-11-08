let quote out value =
  Buffer.add_char out '"';
  String.iter
    (function
      | '"' -> Buffer.add_string out "\\\""
      | '\\' -> Buffer.add_string out "\\\\"
      | '\b' -> Buffer.add_string out "\\b"
      | '\t' -> Buffer.add_string out "\\t"
      | '\n' -> Buffer.add_string out "\\n"
      | '\012' -> Buffer.add_string out "\\f"
      | '\r' -> Buffer.add_string out "\\r"
      | char when Char.code char < 32 ->
          Buffer.add_string out (Printf.sprintf "\\u%04x" (Char.code char))
      | char -> Buffer.add_char out char)
    value;
  Buffer.add_char out '"'

let derive ~resource_id ~motivation ~anchor body =
  let out = Buffer.create 128 in
  let separated write = function
    | [] -> ()
    | first :: rest ->
        write first;
        List.iter
          (fun value ->
            Buffer.add_char out ',';
            write value)
          rest
  in
  let rec write = function
    | `Assoc fields ->
        Buffer.add_char out '{';
        separated
          (fun (key, value) ->
            quote out key;
            Buffer.add_char out ':';
            write value)
          (List.sort (fun (a, _) (b, _) -> String.compare a b) fields);
        Buffer.add_char out '}'
    | `List values ->
        Buffer.add_char out '[';
        separated write values;
        Buffer.add_char out ']'
    | `String value -> quote out value
    | `Intlit value -> Buffer.add_string out (Z.to_string (Z.of_string value))
    | `Float value when Float.is_finite value && Float.is_integer value ->
        Buffer.add_string out (Z.to_string (Z.of_float value))
    | `Float _ -> invalid_arg "annotation body numbers must be whole"
    | value -> Buffer.add_string out (Yojson.Safe.to_string value)
  in
  write
    (`Assoc
       ([
          ("resourceId", `String resource_id);
          ("motivation", `String motivation);
          ("anchor", `String anchor);
        ]
       @ Option.to_list (Option.map (fun body -> ("body", body)) body)));
  let digest =
    Digestif.SHA256.(to_raw_string (digest_string (Buffer.contents out)))
  in
  String.sub
    (Base64.encode_exn ~pad:false ~alphabet:Base64.uri_safe_alphabet digest)
    0 21
