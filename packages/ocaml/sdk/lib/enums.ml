(* Generated from string enums in protocol/specs/src/components/schemas. Do not edit. *)

[@@@ocamlformat "disable"]

module Body_purpose = struct
  type t = Assessing | Bookmarking | Classifying | Commenting | Describing | Editing | Highlighting | Identifying | Linking | Moderating | Questioning | Replying | Tagging
  let to_string = function
    | Assessing -> "assessing"
    | Bookmarking -> "bookmarking"
    | Classifying -> "classifying"
    | Commenting -> "commenting"
    | Describing -> "describing"
    | Editing -> "editing"
    | Highlighting -> "highlighting"
    | Identifying -> "identifying"
    | Linking -> "linking"
    | Moderating -> "moderating"
    | Questioning -> "questioning"
    | Replying -> "replying"
    | Tagging -> "tagging"
  let of_string = function
    | "assessing" -> Some Assessing
    | "bookmarking" -> Some Bookmarking
    | "classifying" -> Some Classifying
    | "commenting" -> Some Commenting
    | "describing" -> Some Describing
    | "editing" -> Some Editing
    | "highlighting" -> Some Highlighting
    | "identifying" -> Some Identifying
    | "linking" -> Some Linking
    | "moderating" -> Some Moderating
    | "questioning" -> Some Questioning
    | "replying" -> Some Replying
    | "tagging" -> Some Tagging
    | _ -> None
end

module Durability_evidence = struct
  type t = Acknowledged | Probe_confirmed | Probe_refused | Probe_unreachable
  let to_string = function
    | Acknowledged -> "acknowledged"
    | Probe_confirmed -> "probe-confirmed"
    | Probe_refused -> "probe-refused"
    | Probe_unreachable -> "probe-unreachable"
  let of_string = function
    | "acknowledged" -> Some Acknowledged
    | "probe-confirmed" -> Some Probe_confirmed
    | "probe-refused" -> Some Probe_refused
    | "probe-unreachable" -> Some Probe_unreachable
    | _ -> None
end

module Failure_class = struct
  type t = Transient | Deterministic | Withheld
  let to_string = function
    | Transient -> "transient"
    | Deterministic -> "deterministic"
    | Withheld -> "withheld"
  let of_string = function
    | "transient" -> Some Transient
    | "deterministic" -> Some Deterministic
    | "withheld" -> Some Withheld
    | _ -> None
end

module Job_type = struct
  type t = Mark | Yield
  let to_string = function
    | Mark -> "mark"
    | Yield -> "yield"
  let of_string = function
    | "mark" -> Some Mark
    | "yield" -> Some Yield
    | _ -> None
end

module Log_format = struct
  type t = Json | Simple
  let to_string = function
    | Json -> "json"
    | Simple -> "simple"
  let of_string = function
    | "json" -> Some Json
    | "simple" -> Some Simple
    | _ -> None
end

module Log_level = struct
  type t = Error | Warn | Info | Http | Debug
  let to_string = function
    | Error -> "error"
    | Warn -> "warn"
    | Info -> "info"
    | Http -> "http"
    | Debug -> "debug"
  let of_string = function
    | "error" -> Some Error
    | "warn" -> Some Warn
    | "info" -> Some Info
    | "http" -> Some Http
    | "debug" -> Some Debug
    | _ -> None
end

module Motivation = struct
  type t = Assessing | Commenting | Highlighting | Linking | Tagging
  let to_string = function
    | Assessing -> "assessing"
    | Commenting -> "commenting"
    | Highlighting -> "highlighting"
    | Linking -> "linking"
    | Tagging -> "tagging"
  let of_string = function
    | "assessing" -> Some Assessing
    | "commenting" -> Some Commenting
    | "highlighting" -> Some Highlighting
    | "linking" -> Some Linking
    | "tagging" -> Some Tagging
    | _ -> None
end

module Supported_media_type = struct
  type t = Text_plain | Text_markdown | Text_html | Text_css | Text_csv | Text_xml | Application_json | Application_xml | Application_yaml | Application_x_yaml | Application_pdf | Application_msword | Application_vnd_openxmlformats_officedocument_wordprocessingml_document | Application_vnd_ms_excel | Application_vnd_openxmlformats_officedocument_spreadsheetml_sheet | Application_vnd_ms_powerpoint | Application_vnd_openxmlformats_officedocument_presentationml_presentation | Application_zip | Application_gzip | Application_x_tar | Application_x_7z_compressed | Application_octet_stream | Application_wasm | Image_png | Image_jpeg | Image_gif | Image_webp | Image_svg_plusxml | Image_bmp | Image_tiff | Image_x_icon | Video_mp4 | Video_mpeg | Video_webm | Video_ogg | Video_quicktime | Video_x_msvideo | Audio_mpeg | Audio_wav | Audio_ogg | Audio_webm | Audio_aac | Audio_flac | Text_javascript | Application_javascript | Text_x_typescript | Application_typescript | Text_x_python | Text_x_java | Text_x_c | Text_x_c_plus_plus | Text_x_csharp | Text_x_go | Text_x_rust | Text_x_ruby | Text_x_php | Text_x_swift | Text_x_kotlin | Text_x_shell | Font_woff | Font_woff2 | Font_ttf | Font_otf
  let to_string = function
    | Text_plain -> "text/plain"
    | Text_markdown -> "text/markdown"
    | Text_html -> "text/html"
    | Text_css -> "text/css"
    | Text_csv -> "text/csv"
    | Text_xml -> "text/xml"
    | Application_json -> "application/json"
    | Application_xml -> "application/xml"
    | Application_yaml -> "application/yaml"
    | Application_x_yaml -> "application/x-yaml"
    | Application_pdf -> "application/pdf"
    | Application_msword -> "application/msword"
    | Application_vnd_openxmlformats_officedocument_wordprocessingml_document -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    | Application_vnd_ms_excel -> "application/vnd.ms-excel"
    | Application_vnd_openxmlformats_officedocument_spreadsheetml_sheet -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    | Application_vnd_ms_powerpoint -> "application/vnd.ms-powerpoint"
    | Application_vnd_openxmlformats_officedocument_presentationml_presentation -> "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    | Application_zip -> "application/zip"
    | Application_gzip -> "application/gzip"
    | Application_x_tar -> "application/x-tar"
    | Application_x_7z_compressed -> "application/x-7z-compressed"
    | Application_octet_stream -> "application/octet-stream"
    | Application_wasm -> "application/wasm"
    | Image_png -> "image/png"
    | Image_jpeg -> "image/jpeg"
    | Image_gif -> "image/gif"
    | Image_webp -> "image/webp"
    | Image_svg_plusxml -> "image/svg+xml"
    | Image_bmp -> "image/bmp"
    | Image_tiff -> "image/tiff"
    | Image_x_icon -> "image/x-icon"
    | Video_mp4 -> "video/mp4"
    | Video_mpeg -> "video/mpeg"
    | Video_webm -> "video/webm"
    | Video_ogg -> "video/ogg"
    | Video_quicktime -> "video/quicktime"
    | Video_x_msvideo -> "video/x-msvideo"
    | Audio_mpeg -> "audio/mpeg"
    | Audio_wav -> "audio/wav"
    | Audio_ogg -> "audio/ogg"
    | Audio_webm -> "audio/webm"
    | Audio_aac -> "audio/aac"
    | Audio_flac -> "audio/flac"
    | Text_javascript -> "text/javascript"
    | Application_javascript -> "application/javascript"
    | Text_x_typescript -> "text/x-typescript"
    | Application_typescript -> "application/typescript"
    | Text_x_python -> "text/x-python"
    | Text_x_java -> "text/x-java"
    | Text_x_c -> "text/x-c"
    | Text_x_c_plus_plus -> "text/x-c++"
    | Text_x_csharp -> "text/x-csharp"
    | Text_x_go -> "text/x-go"
    | Text_x_rust -> "text/x-rust"
    | Text_x_ruby -> "text/x-ruby"
    | Text_x_php -> "text/x-php"
    | Text_x_swift -> "text/x-swift"
    | Text_x_kotlin -> "text/x-kotlin"
    | Text_x_shell -> "text/x-shell"
    | Font_woff -> "font/woff"
    | Font_woff2 -> "font/woff2"
    | Font_ttf -> "font/ttf"
    | Font_otf -> "font/otf"
  let of_string = function
    | "text/plain" -> Some Text_plain
    | "text/markdown" -> Some Text_markdown
    | "text/html" -> Some Text_html
    | "text/css" -> Some Text_css
    | "text/csv" -> Some Text_csv
    | "text/xml" -> Some Text_xml
    | "application/json" -> Some Application_json
    | "application/xml" -> Some Application_xml
    | "application/yaml" -> Some Application_yaml
    | "application/x-yaml" -> Some Application_x_yaml
    | "application/pdf" -> Some Application_pdf
    | "application/msword" -> Some Application_msword
    | "application/vnd.openxmlformats-officedocument.wordprocessingml.document" -> Some Application_vnd_openxmlformats_officedocument_wordprocessingml_document
    | "application/vnd.ms-excel" -> Some Application_vnd_ms_excel
    | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" -> Some Application_vnd_openxmlformats_officedocument_spreadsheetml_sheet
    | "application/vnd.ms-powerpoint" -> Some Application_vnd_ms_powerpoint
    | "application/vnd.openxmlformats-officedocument.presentationml.presentation" -> Some Application_vnd_openxmlformats_officedocument_presentationml_presentation
    | "application/zip" -> Some Application_zip
    | "application/gzip" -> Some Application_gzip
    | "application/x-tar" -> Some Application_x_tar
    | "application/x-7z-compressed" -> Some Application_x_7z_compressed
    | "application/octet-stream" -> Some Application_octet_stream
    | "application/wasm" -> Some Application_wasm
    | "image/png" -> Some Image_png
    | "image/jpeg" -> Some Image_jpeg
    | "image/gif" -> Some Image_gif
    | "image/webp" -> Some Image_webp
    | "image/svg+xml" -> Some Image_svg_plusxml
    | "image/bmp" -> Some Image_bmp
    | "image/tiff" -> Some Image_tiff
    | "image/x-icon" -> Some Image_x_icon
    | "video/mp4" -> Some Video_mp4
    | "video/mpeg" -> Some Video_mpeg
    | "video/webm" -> Some Video_webm
    | "video/ogg" -> Some Video_ogg
    | "video/quicktime" -> Some Video_quicktime
    | "video/x-msvideo" -> Some Video_x_msvideo
    | "audio/mpeg" -> Some Audio_mpeg
    | "audio/wav" -> Some Audio_wav
    | "audio/ogg" -> Some Audio_ogg
    | "audio/webm" -> Some Audio_webm
    | "audio/aac" -> Some Audio_aac
    | "audio/flac" -> Some Audio_flac
    | "text/javascript" -> Some Text_javascript
    | "application/javascript" -> Some Application_javascript
    | "text/x-typescript" -> Some Text_x_typescript
    | "application/typescript" -> Some Application_typescript
    | "text/x-python" -> Some Text_x_python
    | "text/x-java" -> Some Text_x_java
    | "text/x-c" -> Some Text_x_c
    | "text/x-c++" -> Some Text_x_c_plus_plus
    | "text/x-csharp" -> Some Text_x_csharp
    | "text/x-go" -> Some Text_x_go
    | "text/x-rust" -> Some Text_x_rust
    | "text/x-ruby" -> Some Text_x_ruby
    | "text/x-php" -> Some Text_x_php
    | "text/x-swift" -> Some Text_x_swift
    | "text/x-kotlin" -> Some Text_x_kotlin
    | "text/x-shell" -> Some Text_x_shell
    | "font/woff" -> Some Font_woff
    | "font/woff2" -> Some Font_woff2
    | "font/ttf" -> Some Font_ttf
    | "font/otf" -> Some Font_otf
    | _ -> None
end
