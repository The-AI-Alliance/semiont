type t

val of_model : [ `Annotation ] Models.t -> t
val body_source : t -> string option
val is_body_resolved : t -> bool
val target_source : t -> string
val target_selector : t -> Yojson.Safe.t option
val is_highlight : t -> bool
val is_reference : t -> bool
val is_assessment : t -> bool
val is_comment : t -> bool
val is_tag : t -> bool
val is_stub_reference : t -> bool
val is_resolved_reference : t -> bool
val comment_text : t -> string option
val text_quote_selector : Yojson.Safe.t -> Yojson.Safe.t option
val text_position_selector : Yojson.Safe.t -> Yojson.Safe.t option
val svg_selector : Yojson.Safe.t -> Yojson.Safe.t option
val fragment_selector : Yojson.Safe.t -> Yojson.Safe.t option
val exact_text : Yojson.Safe.t option -> string
val annotation_exact_text : t -> string
val entity_types : t -> string list
val tag_category : t -> string option
val tag_schema_id : t -> string option

type quoted_text = {
  exact : string;
  prefix : string option;
  suffix : string option;
}

type text_span = { start : int; end_ : int; quote : quoted_text }
type spanned = Text of string | Pdf of [ `AnchoredText ] Models.t
type span_refused_error = { code : Error_codes.Span_refusal.t }

exception Span_refused of span_refused_error

val annotation_of_resource :
  created:string ->
  resource:Identifiers.Resource_id.t ->
  motivation:Enums.Motivation.t ->
  ?generator:Yojson.Safe.t ->
  ?body:Yojson.Safe.t ->
  unit ->
  ([ `Annotation ] Models.t, Models.decode_error) result

val annotation_of_span :
  created:string ->
  resource:Identifiers.Resource_id.t ->
  motivation:Enums.Motivation.t ->
  generator:Yojson.Safe.t ->
  ?body:Yojson.Safe.t ->
  spanned ->
  text_span ->
  ([ `Annotation ] Models.t, Models.decode_error) result

type anchor_method =
  | Unique_match
  | Context_recovered
  | First_of_many
  | Fuzzy_match

type match_quality = Normalized | Case_insensitive | Fuzzy

type reconciled_span = {
  span : text_span;
  anchor_method : anchor_method;
  match_quality : match_quality option;
}

val reconcile : string -> quoted_text -> reconciled_span option

type pdf_item = {
  start : int;
  end_ : int;
  page : int;
  x : float;
  y : float;
  width : float;
  height : float;
}

val locate_pdf :
  pdf_item list -> int -> int -> pdf_item list * Yojson.Safe.t list

val fragment : Yojson.Safe.t -> string
