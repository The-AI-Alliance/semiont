type refusal =
  | Unsupported_media_type of string
  | Unsupported_charset of string

let http_space = function ' ' | '\t' | '\r' | '\n' -> true | _ -> false
let ascii_space char = http_space char || char = '\012'

let trim space source =
  let n = String.length source in
  let rec first i = if i < n && space source.[i] then first (i + 1) else i in
  let start = first 0 in
  let rec last i =
    if i > start && space source.[i - 1] then last (i - 1) else i
  in
  String.sub source start (last n - start)

let token source =
  source <> ""
  && String.for_all
       (function
         | 'A' .. 'Z' | 'a' .. 'z' | '0' .. '9' -> true
         | char -> String.contains "!#$%&'*+-.^_`|~" char)
       source

let parameter_value value =
  Uutf.String.fold_utf_8
    (fun valid _ -> function
      | `Malformed _ -> false
      | `Uchar char ->
          let code = Uchar.to_int char in
          valid
          && (code = 9
             || (code >= 32 && code <= 126)
             || (code >= 128 && code <= 255)))
    true value

let charset content_type =
  let input = trim http_space content_type in
  let length = String.length input in
  let find from predicate =
    let rec loop i =
      if i = length || predicate input.[i] then i else loop (i + 1)
    in
    loop from
  in
  let part a b = String.sub input a (b - a) in
  let semicolon from = find from (Char.equal ';') in
  let type_end = semicolon 0 in
  let valid_type =
    match String.split_on_char '/' (part 0 type_end) with
    | [ typ; subtype ] ->
        token typ
        &&
        let subtype_end = ref (String.length subtype) in
        while !subtype_end > 0 && http_space subtype.[!subtype_end - 1] do
          decr subtype_end
        done;
        token (String.sub subtype 0 !subtype_end)
    | _ -> false
  in
  let quoted start =
    let value = Buffer.create 16 in
    let rec loop i =
      if i = length then i
      else
        match input.[i] with
        | '"' -> i + 1
        | '\\' when i + 1 < length ->
            Buffer.add_char value input.[i + 1];
            loop (i + 2)
        | char ->
            Buffer.add_char value char;
            loop (i + 1)
    in
    let stop = loop start in
    (Buffer.contents value, semicolon stop)
  in
  let rec params i =
    if i >= length then None
    else
      let start = find (i + 1) (fun c -> not (http_space c)) in
      let key_end = find start (function '=' | ';' -> true | _ -> false) in
      if key_end >= length then None
      else if input.[key_end] = ';' then params key_end
      else
        let start_value = key_end + 1 in
        if start_value = length then None
        else
          let is_quoted = input.[start_value] = '"' in
          let value, stop =
            if is_quoted then quoted (start_value + 1)
            else
              let stop = semicolon start_value in
              let end_ = ref stop in
              while !end_ > start_value && http_space input.[!end_ - 1] do
                decr end_
              done;
              (part start_value !end_, stop)
          in
          if
            (is_quoted || value <> "")
            && String.lowercase_ascii (part start key_end) = "charset"
            && parameter_value value
          then Some value
          else params stop
  in
  if valid_type then params type_end else None

let add buffer code = Uutf.Buffer.add_utf_8 buffer (Uchar.of_int code)
let replacement buffer = add buffer 0xfffd
let byte data index = Char.code data.[index]

let utf8 data start =
  let length = String.length data in
  let output = Buffer.create length in
  let rec sequence i remaining code lower upper =
    if remaining = 0 then (
      add output code;
      scan i)
    else if i = length then replacement output
    else
      let next = byte data i in
      if next < lower || next > upper then (
        replacement output;
        scan i)
      else
        sequence (i + 1) (remaining - 1)
          ((code lsl 6) lor (next land 63))
          0x80 0xbf
  and scan i =
    if i < length then
      let lead = byte data i in
      if lead <= 0x7f then (
        Buffer.add_char output data.[i];
        scan (i + 1))
      else if lead >= 0xc2 && lead <= 0xdf then
        sequence (i + 1) 1 (lead land 31) 0x80 0xbf
      else if lead >= 0xe0 && lead <= 0xef then
        sequence (i + 1) 2 (lead land 15)
          (if lead = 0xe0 then 0xa0 else 0x80)
          (if lead = 0xed then 0x9f else 0xbf)
      else if lead >= 0xf0 && lead <= 0xf4 then
        sequence (i + 1) 3 (lead land 7)
          (if lead = 0xf0 then 0x90 else 0x80)
          (if lead = 0xf4 then 0x8f else 0xbf)
      else (
        replacement output;
        scan (i + 1))
  in
  scan start;
  Buffer.contents output

let utf16 ~little data start =
  let length = String.length data in
  let output = Buffer.create length in
  let unit i =
    let a = byte data i and b = byte data (i + 1) in
    if little then a lor (b lsl 8) else (a lsl 8) lor b
  in
  let rec scan i =
    if i + 1 >= length then (if i < length then replacement output)
    else
      let lead = unit i in
      if lead >= 0xd800 && lead <= 0xdbff then
        if i + 3 >= length then replacement output
        else
          let trail = unit (i + 2) in
          if trail >= 0xdc00 && trail <= 0xdfff then (
            add output (0x10000 + ((lead - 0xd800) lsl 10) + trail - 0xdc00);
            scan (i + 4))
          else (
            replacement output;
            scan (i + 2))
      else (
        if lead >= 0xdc00 && lead <= 0xdfff then replacement output
        else add output lead;
        scan (i + 2))
  in
  scan start;
  Buffer.contents output

let single_byte =
  lazy
    (List.map
       (fun (name, text) ->
         let codes =
           Uutf.String.fold_utf_8
             (fun codes _ -> function
               | `Uchar char -> Uchar.to_int char :: codes
               | `Malformed _ -> assert false)
             [] text
         in
         (name, Array.of_list (List.rev codes)))
       Encoding_facts.single_byte)

let decode ~content_type data =
  if Media_types.text_source content_type <> Media_types.Decode then
    Error (Unsupported_media_type (Media_types.base content_type))
  else
    let label =
      Option.value (charset content_type) ~default:""
      |> trim ascii_space |> String.lowercase_ascii
    in
    let selected =
      if label = "" then Some "utf-8"
      else List.assoc_opt label Encoding_facts.labels
    in
    match selected with
    | None -> Error (Unsupported_charset label)
    | Some encoding when List.mem encoding Encoding_facts.refused ->
        Error (Unsupported_charset label)
    | Some encoding -> (
        if String.starts_with ~prefix:"\239\187\191" data then Ok (utf8 data 3)
        else if String.starts_with ~prefix:"\254\255" data then
          Ok (utf16 ~little:false data 2)
        else if String.starts_with ~prefix:"\255\254" data then
          Ok (utf16 ~little:true data 2)
        else
          match encoding with
          | "utf-8" -> Ok (utf8 data 0)
          | "utf-16be" -> Ok (utf16 ~little:false data 0)
          | "utf-16le" -> Ok (utf16 ~little:true data 0)
          | encoding ->
              let codes = List.assoc encoding (Lazy.force single_byte) in
              let output = Buffer.create (String.length data) in
              String.iter (fun char -> add output codes.(Char.code char)) data;
              Ok (Buffer.contents output))
