(* Generated from Selector.json and its component branches. Do not edit. *)

[@@@ocamlformat "disable"]

type text_position_selector = { start : Z.t; end_ : Z.t; extra : (string * Yojson.Safe.t) list }
type text_quote_selector = { exact : string; prefix : string option; suffix : string option; extra : (string * Yojson.Safe.t) list }
type svg_selector = { value : string; extra : (string * Yojson.Safe.t) list }
type fragment_selector = { value : string; conforms_to : string option; extra : (string * Yojson.Safe.t) list }
type t = TextPositionSelector of text_position_selector | TextQuoteSelector of text_quote_selector | SvgSelector of svg_selector | FragmentSelector of fragment_selector
type fault = { member : string; reason : [ `Lacks | `Malformed ] }
val of_json : Yojson.Safe.t -> (t, fault) result
val to_json : t -> Yojson.Safe.t
