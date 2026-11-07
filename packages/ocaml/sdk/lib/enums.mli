(* Generated from string enums in protocol/specs/src/components/schemas. Do not edit. *)

[@@@ocamlformat "disable"]

module Body_purpose : sig
  type t = Assessing | Bookmarking | Classifying | Commenting | Describing | Editing | Highlighting | Identifying | Linking | Moderating | Questioning | Replying | Tagging
  val to_string : t -> string
  val of_string : string -> t option
end

module Durability_evidence : sig
  type t = Acknowledged | Probe_confirmed | Probe_refused | Probe_unreachable
  val to_string : t -> string
  val of_string : string -> t option
end

module Failure_class : sig
  type t = Transient | Deterministic | Withheld
  val to_string : t -> string
  val of_string : string -> t option
end

module Job_type : sig
  type t = Mark | Yield
  val to_string : t -> string
  val of_string : string -> t option
end

module Log_format : sig
  type t = Json | Simple
  val to_string : t -> string
  val of_string : string -> t option
end

module Log_level : sig
  type t = Error | Warn | Info | Http | Debug
  val to_string : t -> string
  val of_string : string -> t option
end

module Motivation : sig
  type t = Assessing | Commenting | Highlighting | Linking | Tagging
  val to_string : t -> string
  val of_string : string -> t option
end

module Supported_media_type : sig
  type t = Text_plain | Text_markdown | Text_html | Text_css | Text_csv | Text_xml | Application_json | Application_xml | Application_yaml | Application_x_yaml | Application_pdf | Application_msword | Application_vnd_openxmlformats_officedocument_wordprocessingml_document | Application_vnd_ms_excel | Application_vnd_openxmlformats_officedocument_spreadsheetml_sheet | Application_vnd_ms_powerpoint | Application_vnd_openxmlformats_officedocument_presentationml_presentation | Application_zip | Application_gzip | Application_x_tar | Application_x_7z_compressed | Application_octet_stream | Application_wasm | Image_png | Image_jpeg | Image_gif | Image_webp | Image_svg_plusxml | Image_bmp | Image_tiff | Image_x_icon | Video_mp4 | Video_mpeg | Video_webm | Video_ogg | Video_quicktime | Video_x_msvideo | Audio_mpeg | Audio_wav | Audio_ogg | Audio_webm | Audio_aac | Audio_flac | Text_javascript | Application_javascript | Text_x_typescript | Application_typescript | Text_x_python | Text_x_java | Text_x_c | Text_x_c_plus_plus | Text_x_csharp | Text_x_go | Text_x_rust | Text_x_ruby | Text_x_php | Text_x_swift | Text_x_kotlin | Text_x_shell | Font_woff | Font_woff2 | Font_ttf | Font_otf
  val to_string : t -> string
  val of_string : string -> t option
end
