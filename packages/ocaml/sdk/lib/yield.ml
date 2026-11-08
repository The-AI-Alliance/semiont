include Namespace_methods.Yield

let delegate follower ?stall_ms ~params ~on_report ~on_failure ~on_close () =
  Delegation.start follower ~verb:"yield" ?stall_ms
    ~params:(Yojson.Safe.from_string (Models.encode params))
    ~on_report ~on_failure ~on_close ()

let resource client ~fields ~bytes ~on_progress =
  Upload.make (fun () ->
      Client_core.content (fun () ->
          Http_wire.put (Client_core.http client) ~fields ~bytes ~on_progress))

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
          let format = Media_types.clone_format media in
          let fields =
            [
              ("name", name);
              ("format", format);
              ( "storageUri",
                "file://" ^ Media_types.storage_file_name ~name ~format );
              ("cloneToken", token);
            ]
            @ Option.to_list
                (Option.map
                   (fun value -> ("archiveOriginal", string_of_bool value))
                   archive_original)
          in
          Upload.await
            (resource client ~fields ~bytes:content ~on_progress:ignore))
