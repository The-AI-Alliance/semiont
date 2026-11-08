include Namespace_methods.Yield

let delegate follower ?stall_ms ~params ~on_report ~on_failure ~on_close () =
  Delegation.start follower ~verb:"yield" ?stall_ms
    ~params:(Yojson.Safe.from_string (Models.encode params))
    ~on_report ~on_failure ~on_close ()

let resource client ~fields ~bytes ~on_progress =
  Upload.make (fun () ->
      Client_core.content (fun () ->
          Http_wire.put (Client_core.http client) ~fields ~bytes ~on_progress))

let storage_name name extension =
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
  Buffer.contents slug ^ extension

let create_from_token client ~token ~name ~content ?archive_original () =
  let module B = Bus_registry in
  let request = Yojson.Safe.to_string (`Assoc [ ("token", `String token) ]) in
  match B.decode B.Channels.yield_clone_resource_requested request with
  | Error _ -> Error (Client_core.Refused "bad-request")
  | Ok payload ->
      Result.bind (from_token client payload) (fun reply ->
          let open Yojson.Safe.Util in
          let descriptor =
            Yojson.Safe.from_string (B.encode reply)
            |> member "response" |> member "sourceResource"
          in
          let media =
            let representation =
              match member "representations" descriptor with
              | `List (first :: _) -> first
              | `Assoc _ as first -> first
              | _ -> `Null
            in
            match representation with
            | `Assoc _ -> (
                match member "mediaType" representation with
                | `String value ->
                    String.split_on_char ';' value
                    |> List.hd |> String.trim |> String.lowercase_ascii
                | _ -> "")
            | _ -> ""
          in
          let fallback = "text/plain" in
          let format, extension =
            match List.assoc_opt media Clone_facts.authorable with
            | Some extension -> (media, extension)
            | None -> (fallback, List.assoc fallback Clone_facts.authorable)
          in
          let fields =
            [
              ("name", name);
              ("format", format);
              ("storageUri", "file://" ^ storage_name name extension);
              ("cloneToken", token);
            ]
            @ Option.to_list
                (Option.map
                   (fun value -> ("archiveOriginal", string_of_bool value))
                   archive_original)
          in
          Upload.await
            (resource client ~fields ~bytes:content ~on_progress:ignore))
