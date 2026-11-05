-- Generated from protocol/specs/src. Run semiont-codegen; do not edit.
{-# LANGUAGE OverloadedStrings #-}

{-# OPTIONS_GHC -Wno-unused-imports #-}
module Semiont.Internal.Generated.Models.SupportedMediaType
  ( SupportedMediaType(..)
  ) where
import Control.Applicative ((<|>))
import Data.Aeson (FromJSON(..), ToJSON(..), Value(..), withObject, (.:))
import Data.Aeson.Types (parseEither)
import qualified Data.Aeson.KeyMap as KM
import Data.Scientific (Scientific)
import Data.Text (Text)
import Semiont.Internal.Codec
import Semiont.Types.Presence (Presence)
data SupportedMediaType = SupportedMediaTypeTextU2f_plain | SupportedMediaTypeTextU2f_markdown | SupportedMediaTypeTextU2f_html | SupportedMediaTypeTextU2f_css | SupportedMediaTypeTextU2f_csv | SupportedMediaTypeTextU2f_xml | SupportedMediaTypeApplicationU2f_json | SupportedMediaTypeApplicationU2f_xml | SupportedMediaTypeApplicationU2f_yaml | SupportedMediaTypeApplicationU2f_xU2d_yaml | SupportedMediaTypeApplicationU2f_pdf | SupportedMediaTypeApplicationU2f_msword | SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_wordprocessingmlU2e_document | SupportedMediaTypeApplicationU2f_vndU2e_msU2d_excel | SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_spreadsheetmlU2e_sheet | SupportedMediaTypeApplicationU2f_vndU2e_msU2d_powerpoint | SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_presentationmlU2e_presentation | SupportedMediaTypeApplicationU2f_zip | SupportedMediaTypeApplicationU2f_gzip | SupportedMediaTypeApplicationU2f_xU2d_tar | SupportedMediaTypeApplicationU2f_xU2d_7zU2d_compressed | SupportedMediaTypeApplicationU2f_octetU2d_stream | SupportedMediaTypeApplicationU2f_wasm | SupportedMediaTypeImageU2f_png | SupportedMediaTypeImageU2f_jpeg | SupportedMediaTypeImageU2f_gif | SupportedMediaTypeImageU2f_webp | SupportedMediaTypeImageU2f_svgU2b_xml | SupportedMediaTypeImageU2f_bmp | SupportedMediaTypeImageU2f_tiff | SupportedMediaTypeImageU2f_xU2d_icon | SupportedMediaTypeVideoU2f_mp4 | SupportedMediaTypeVideoU2f_mpeg | SupportedMediaTypeVideoU2f_webm | SupportedMediaTypeVideoU2f_ogg | SupportedMediaTypeVideoU2f_quicktime | SupportedMediaTypeVideoU2f_xU2d_msvideo | SupportedMediaTypeAudioU2f_mpeg | SupportedMediaTypeAudioU2f_wav | SupportedMediaTypeAudioU2f_ogg | SupportedMediaTypeAudioU2f_webm | SupportedMediaTypeAudioU2f_aac | SupportedMediaTypeAudioU2f_flac | SupportedMediaTypeTextU2f_javascript | SupportedMediaTypeApplicationU2f_javascript | SupportedMediaTypeTextU2f_xU2d_typescript | SupportedMediaTypeApplicationU2f_typescript | SupportedMediaTypeTextU2f_xU2d_python | SupportedMediaTypeTextU2f_xU2d_java | SupportedMediaTypeTextU2f_xU2d_c | SupportedMediaTypeTextU2f_xU2d_cU2b_U2b_ | SupportedMediaTypeTextU2f_xU2d_csharp | SupportedMediaTypeTextU2f_xU2d_go | SupportedMediaTypeTextU2f_xU2d_rust | SupportedMediaTypeTextU2f_xU2d_ruby | SupportedMediaTypeTextU2f_xU2d_php | SupportedMediaTypeTextU2f_xU2d_swift | SupportedMediaTypeTextU2f_xU2d_kotlin | SupportedMediaTypeTextU2f_xU2d_shell | SupportedMediaTypeFontU2f_woff | SupportedMediaTypeFontU2f_woff2 | SupportedMediaTypeFontU2f_ttf | SupportedMediaTypeFontU2f_otf deriving (Eq, Show)
instance FromJSON SupportedMediaType where
  parseJSON = checked "SupportedMediaType" $ \value -> if value == (String "text/plain") then pure SupportedMediaTypeTextU2f_plain else if value == (String "text/markdown") then pure SupportedMediaTypeTextU2f_markdown else if value == (String "text/html") then pure SupportedMediaTypeTextU2f_html else if value == (String "text/css") then pure SupportedMediaTypeTextU2f_css else if value == (String "text/csv") then pure SupportedMediaTypeTextU2f_csv else if value == (String "text/xml") then pure SupportedMediaTypeTextU2f_xml else if value == (String "application/json") then pure SupportedMediaTypeApplicationU2f_json else if value == (String "application/xml") then pure SupportedMediaTypeApplicationU2f_xml else if value == (String "application/yaml") then pure SupportedMediaTypeApplicationU2f_yaml else if value == (String "application/x-yaml") then pure SupportedMediaTypeApplicationU2f_xU2d_yaml else if value == (String "application/pdf") then pure SupportedMediaTypeApplicationU2f_pdf else if value == (String "application/msword") then pure SupportedMediaTypeApplicationU2f_msword else if value == (String "application/vnd.openxmlformats-officedocument.wordprocessingml.document") then pure SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_wordprocessingmlU2e_document else if value == (String "application/vnd.ms-excel") then pure SupportedMediaTypeApplicationU2f_vndU2e_msU2d_excel else if value == (String "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") then pure SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_spreadsheetmlU2e_sheet else if value == (String "application/vnd.ms-powerpoint") then pure SupportedMediaTypeApplicationU2f_vndU2e_msU2d_powerpoint else if value == (String "application/vnd.openxmlformats-officedocument.presentationml.presentation") then pure SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_presentationmlU2e_presentation else if value == (String "application/zip") then pure SupportedMediaTypeApplicationU2f_zip else if value == (String "application/gzip") then pure SupportedMediaTypeApplicationU2f_gzip else if value == (String "application/x-tar") then pure SupportedMediaTypeApplicationU2f_xU2d_tar else if value == (String "application/x-7z-compressed") then pure SupportedMediaTypeApplicationU2f_xU2d_7zU2d_compressed else if value == (String "application/octet-stream") then pure SupportedMediaTypeApplicationU2f_octetU2d_stream else if value == (String "application/wasm") then pure SupportedMediaTypeApplicationU2f_wasm else if value == (String "image/png") then pure SupportedMediaTypeImageU2f_png else if value == (String "image/jpeg") then pure SupportedMediaTypeImageU2f_jpeg else if value == (String "image/gif") then pure SupportedMediaTypeImageU2f_gif else if value == (String "image/webp") then pure SupportedMediaTypeImageU2f_webp else if value == (String "image/svg+xml") then pure SupportedMediaTypeImageU2f_svgU2b_xml else if value == (String "image/bmp") then pure SupportedMediaTypeImageU2f_bmp else if value == (String "image/tiff") then pure SupportedMediaTypeImageU2f_tiff else if value == (String "image/x-icon") then pure SupportedMediaTypeImageU2f_xU2d_icon else if value == (String "video/mp4") then pure SupportedMediaTypeVideoU2f_mp4 else if value == (String "video/mpeg") then pure SupportedMediaTypeVideoU2f_mpeg else if value == (String "video/webm") then pure SupportedMediaTypeVideoU2f_webm else if value == (String "video/ogg") then pure SupportedMediaTypeVideoU2f_ogg else if value == (String "video/quicktime") then pure SupportedMediaTypeVideoU2f_quicktime else if value == (String "video/x-msvideo") then pure SupportedMediaTypeVideoU2f_xU2d_msvideo else if value == (String "audio/mpeg") then pure SupportedMediaTypeAudioU2f_mpeg else if value == (String "audio/wav") then pure SupportedMediaTypeAudioU2f_wav else if value == (String "audio/ogg") then pure SupportedMediaTypeAudioU2f_ogg else if value == (String "audio/webm") then pure SupportedMediaTypeAudioU2f_webm else if value == (String "audio/aac") then pure SupportedMediaTypeAudioU2f_aac else if value == (String "audio/flac") then pure SupportedMediaTypeAudioU2f_flac else if value == (String "text/javascript") then pure SupportedMediaTypeTextU2f_javascript else if value == (String "application/javascript") then pure SupportedMediaTypeApplicationU2f_javascript else if value == (String "text/x-typescript") then pure SupportedMediaTypeTextU2f_xU2d_typescript else if value == (String "application/typescript") then pure SupportedMediaTypeApplicationU2f_typescript else if value == (String "text/x-python") then pure SupportedMediaTypeTextU2f_xU2d_python else if value == (String "text/x-java") then pure SupportedMediaTypeTextU2f_xU2d_java else if value == (String "text/x-c") then pure SupportedMediaTypeTextU2f_xU2d_c else if value == (String "text/x-c++") then pure SupportedMediaTypeTextU2f_xU2d_cU2b_U2b_ else if value == (String "text/x-csharp") then pure SupportedMediaTypeTextU2f_xU2d_csharp else if value == (String "text/x-go") then pure SupportedMediaTypeTextU2f_xU2d_go else if value == (String "text/x-rust") then pure SupportedMediaTypeTextU2f_xU2d_rust else if value == (String "text/x-ruby") then pure SupportedMediaTypeTextU2f_xU2d_ruby else if value == (String "text/x-php") then pure SupportedMediaTypeTextU2f_xU2d_php else if value == (String "text/x-swift") then pure SupportedMediaTypeTextU2f_xU2d_swift else if value == (String "text/x-kotlin") then pure SupportedMediaTypeTextU2f_xU2d_kotlin else if value == (String "text/x-shell") then pure SupportedMediaTypeTextU2f_xU2d_shell else if value == (String "font/woff") then pure SupportedMediaTypeFontU2f_woff else if value == (String "font/woff2") then pure SupportedMediaTypeFontU2f_woff2 else if value == (String "font/ttf") then pure SupportedMediaTypeFontU2f_ttf else if value == (String "font/otf") then pure SupportedMediaTypeFontU2f_otf else fail "unknown enumeration member"
instance ToJSON SupportedMediaType where
  toJSON SupportedMediaTypeTextU2f_plain = String "text/plain"
  toJSON SupportedMediaTypeTextU2f_markdown = String "text/markdown"
  toJSON SupportedMediaTypeTextU2f_html = String "text/html"
  toJSON SupportedMediaTypeTextU2f_css = String "text/css"
  toJSON SupportedMediaTypeTextU2f_csv = String "text/csv"
  toJSON SupportedMediaTypeTextU2f_xml = String "text/xml"
  toJSON SupportedMediaTypeApplicationU2f_json = String "application/json"
  toJSON SupportedMediaTypeApplicationU2f_xml = String "application/xml"
  toJSON SupportedMediaTypeApplicationU2f_yaml = String "application/yaml"
  toJSON SupportedMediaTypeApplicationU2f_xU2d_yaml = String "application/x-yaml"
  toJSON SupportedMediaTypeApplicationU2f_pdf = String "application/pdf"
  toJSON SupportedMediaTypeApplicationU2f_msword = String "application/msword"
  toJSON SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_wordprocessingmlU2e_document = String "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  toJSON SupportedMediaTypeApplicationU2f_vndU2e_msU2d_excel = String "application/vnd.ms-excel"
  toJSON SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_spreadsheetmlU2e_sheet = String "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  toJSON SupportedMediaTypeApplicationU2f_vndU2e_msU2d_powerpoint = String "application/vnd.ms-powerpoint"
  toJSON SupportedMediaTypeApplicationU2f_vndU2e_openxmlformatsU2d_officedocumentU2e_presentationmlU2e_presentation = String "application/vnd.openxmlformats-officedocument.presentationml.presentation"
  toJSON SupportedMediaTypeApplicationU2f_zip = String "application/zip"
  toJSON SupportedMediaTypeApplicationU2f_gzip = String "application/gzip"
  toJSON SupportedMediaTypeApplicationU2f_xU2d_tar = String "application/x-tar"
  toJSON SupportedMediaTypeApplicationU2f_xU2d_7zU2d_compressed = String "application/x-7z-compressed"
  toJSON SupportedMediaTypeApplicationU2f_octetU2d_stream = String "application/octet-stream"
  toJSON SupportedMediaTypeApplicationU2f_wasm = String "application/wasm"
  toJSON SupportedMediaTypeImageU2f_png = String "image/png"
  toJSON SupportedMediaTypeImageU2f_jpeg = String "image/jpeg"
  toJSON SupportedMediaTypeImageU2f_gif = String "image/gif"
  toJSON SupportedMediaTypeImageU2f_webp = String "image/webp"
  toJSON SupportedMediaTypeImageU2f_svgU2b_xml = String "image/svg+xml"
  toJSON SupportedMediaTypeImageU2f_bmp = String "image/bmp"
  toJSON SupportedMediaTypeImageU2f_tiff = String "image/tiff"
  toJSON SupportedMediaTypeImageU2f_xU2d_icon = String "image/x-icon"
  toJSON SupportedMediaTypeVideoU2f_mp4 = String "video/mp4"
  toJSON SupportedMediaTypeVideoU2f_mpeg = String "video/mpeg"
  toJSON SupportedMediaTypeVideoU2f_webm = String "video/webm"
  toJSON SupportedMediaTypeVideoU2f_ogg = String "video/ogg"
  toJSON SupportedMediaTypeVideoU2f_quicktime = String "video/quicktime"
  toJSON SupportedMediaTypeVideoU2f_xU2d_msvideo = String "video/x-msvideo"
  toJSON SupportedMediaTypeAudioU2f_mpeg = String "audio/mpeg"
  toJSON SupportedMediaTypeAudioU2f_wav = String "audio/wav"
  toJSON SupportedMediaTypeAudioU2f_ogg = String "audio/ogg"
  toJSON SupportedMediaTypeAudioU2f_webm = String "audio/webm"
  toJSON SupportedMediaTypeAudioU2f_aac = String "audio/aac"
  toJSON SupportedMediaTypeAudioU2f_flac = String "audio/flac"
  toJSON SupportedMediaTypeTextU2f_javascript = String "text/javascript"
  toJSON SupportedMediaTypeApplicationU2f_javascript = String "application/javascript"
  toJSON SupportedMediaTypeTextU2f_xU2d_typescript = String "text/x-typescript"
  toJSON SupportedMediaTypeApplicationU2f_typescript = String "application/typescript"
  toJSON SupportedMediaTypeTextU2f_xU2d_python = String "text/x-python"
  toJSON SupportedMediaTypeTextU2f_xU2d_java = String "text/x-java"
  toJSON SupportedMediaTypeTextU2f_xU2d_c = String "text/x-c"
  toJSON SupportedMediaTypeTextU2f_xU2d_cU2b_U2b_ = String "text/x-c++"
  toJSON SupportedMediaTypeTextU2f_xU2d_csharp = String "text/x-csharp"
  toJSON SupportedMediaTypeTextU2f_xU2d_go = String "text/x-go"
  toJSON SupportedMediaTypeTextU2f_xU2d_rust = String "text/x-rust"
  toJSON SupportedMediaTypeTextU2f_xU2d_ruby = String "text/x-ruby"
  toJSON SupportedMediaTypeTextU2f_xU2d_php = String "text/x-php"
  toJSON SupportedMediaTypeTextU2f_xU2d_swift = String "text/x-swift"
  toJSON SupportedMediaTypeTextU2f_xU2d_kotlin = String "text/x-kotlin"
  toJSON SupportedMediaTypeTextU2f_xU2d_shell = String "text/x-shell"
  toJSON SupportedMediaTypeFontU2f_woff = String "font/woff"
  toJSON SupportedMediaTypeFontU2f_woff2 = String "font/woff2"
  toJSON SupportedMediaTypeFontU2f_ttf = String "font/ttf"
  toJSON SupportedMediaTypeFontU2f_otf = String "font/otf"


