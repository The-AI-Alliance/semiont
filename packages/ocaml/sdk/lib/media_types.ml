type text_source = Decode | Pdf_text_layer | No_text

let base value =
  String.split_on_char ';' value
  |> List.hd |> String.trim |> String.lowercase_ascii

let row value = List.assoc_opt (base value) Media_facts.types

let clone_format value =
  match row value with Some (_, true, _) -> base value | _ -> "text/plain"

let text_source value =
  match row value with
  | Some (_, _, "decode") -> Decode
  | Some (_, _, "pdf-text-layer") -> Pdf_text_layer
  | None when String.starts_with ~prefix:"text/" (base value) -> Decode
  | _ -> No_text

let yields_geometry value = text_source value = Pdf_text_layer
let derives_text value = text_source value = Pdf_text_layer

let slug name =
  let slug = Buffer.create (String.length name) in
  let separator = ref false in
  let add code =
    if (code >= 97 && code <= 122) || (code >= 48 && code <= 57) then (
      if !separator && Buffer.length slug > 0 then Buffer.add_char slug '-';
      separator := false;
      Buffer.add_char slug (Char.chr code))
    else separator := true
  in
  Uutf.String.fold_utf_8
    (fun () _ -> function
      | `Malformed _ -> separator := true
      | `Uchar uchar -> (
          match Uucp.Case.Map.to_lower uchar with
          | `Self -> add (Uchar.to_int uchar)
          | `Uchars characters ->
              List.iter (fun ch -> add (Uchar.to_int ch)) characters))
    () name;
  Buffer.contents slug

let storage_file_name ~name ~format =
  let extension =
    match row format with Some (extension, _, _) -> extension | None -> ""
  in
  slug name ^ extension
