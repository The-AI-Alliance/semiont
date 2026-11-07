(* Generated from Selector.json and its component branches. Do not edit. *)

[@@@ocamlformat "disable"]

type text_position_selector = { start : Z.t; end_ : Z.t; extra : (string * Yojson.Safe.t) list }
type text_quote_selector = { exact : string; prefix : string option; suffix : string option; extra : (string * Yojson.Safe.t) list }
type svg_selector = { value : string; extra : (string * Yojson.Safe.t) list }
type fragment_selector = { value : string; conforms_to : string option; extra : (string * Yojson.Safe.t) list }
type t = TextPositionSelector of text_position_selector | TextQuoteSelector of text_quote_selector | SvgSelector of svg_selector | FragmentSelector of fragment_selector
type fault = { member : string; reason : [ `Lacks | `Malformed ] }
let ( let* ) = Result.bind
let malformed member = Error { member; reason = `Malformed }
let string member = function `String value -> Ok value | _ -> malformed member
let integer member = function
  | `Int value -> Ok (Z.of_int value)
  | `Intlit value ->
      (try
         let number = Z.of_string value in
         if Z.to_string number = value || value = "-0" then Ok number else malformed member
       with Invalid_argument _ -> malformed member)
  | _ -> malformed member
let integer_at_least minimum member json =
  let* value = integer member json in
  if Z.geq value (Z.of_int minimum) then Ok value else malformed member
let required read member fields =
  match List.assoc_opt member fields with
  | None -> Error { member; reason = `Lacks }
  | Some value -> read member value
let optional read member fields =
  match List.assoc_opt member fields with
  | None -> Ok None
  | Some value -> Result.map Option.some (read member value)
let extra names = List.filter (fun (name, _) -> not (List.mem name names))
let json_string value = `String value
let json_integer value = if Z.fits_int value then `Int (Z.to_int value) else `Intlit (Z.to_string value)
let of_json = function
  | `Assoc fields ->
      let* tag = required string "type" fields in
      (match tag with
    | "TextPositionSelector" ->
        let* start = required (integer_at_least 0) "start" fields in
        let* end_ = required (integer_at_least 0) "end" fields in
        Ok (TextPositionSelector { start; end_; extra = extra ["type"; "start"; "end"] fields })
    | "TextQuoteSelector" ->
        let* exact = required string "exact" fields in
        let* prefix = optional string "prefix" fields in
        let* suffix = optional string "suffix" fields in
        Ok (TextQuoteSelector { exact; prefix; suffix; extra = extra ["type"; "exact"; "prefix"; "suffix"] fields })
    | "SvgSelector" ->
        let* value = required string "value" fields in
        Ok (SvgSelector { value; extra = extra ["type"; "value"] fields })
    | "FragmentSelector" ->
        let* value = required string "value" fields in
        let* conforms_to = optional string "conformsTo" fields in
        Ok (FragmentSelector { value; conforms_to; extra = extra ["type"; "value"; "conformsTo"] fields })
    | _ -> malformed "type")
  | _ -> malformed ""
let to_json = function
  | TextPositionSelector value ->
      `Assoc (List.filter_map Fun.id [Some ("type", `String "TextPositionSelector");
        Some ("start", json_integer value.start);
        Some ("end", json_integer value.end_);
      ] @ extra ["type"; "start"; "end"] value.extra)
  | TextQuoteSelector value ->
      `Assoc (List.filter_map Fun.id [Some ("type", `String "TextQuoteSelector");
        Some ("exact", json_string value.exact);
        Option.map (fun field -> ("prefix", json_string field)) value.prefix;
        Option.map (fun field -> ("suffix", json_string field)) value.suffix;
      ] @ extra ["type"; "exact"; "prefix"; "suffix"] value.extra)
  | SvgSelector value ->
      `Assoc (List.filter_map Fun.id [Some ("type", `String "SvgSelector");
        Some ("value", json_string value.value);
      ] @ extra ["type"; "value"] value.extra)
  | FragmentSelector value ->
      `Assoc (List.filter_map Fun.id [Some ("type", `String "FragmentSelector");
        Some ("value", json_string value.value);
        Option.map (fun field -> ("conformsTo", json_string field)) value.conforms_to;
      ] @ extra ["type"; "value"; "conformsTo"] value.extra)
