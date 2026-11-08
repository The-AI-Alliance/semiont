module J = Yojson.Safe.Util

let primary_representation model =
  let fields = Records.Resource_descriptor.of_model model in
  match fields.representations with
  | `List (first :: _) -> Some first
  | `Assoc _ as value -> Some value
  | _ -> None

let primary_media_type model =
  Option.map
    (fun value ->
      Yojson.Safe.from_string (Yojson.Raw.to_string value)
      |> J.member "mediaType" |> J.to_string)
    (primary_representation model)

let entity_types model =
  let fields = Records.Resource_descriptor.of_model model in
  match fields.entity_types with
  | Types.Present (`List values) ->
      List.map
        (fun value ->
          Yojson.Safe.from_string (Yojson.Raw.to_string value) |> J.to_string)
        values
  | _ -> []

let resource_text client id =
  Result.map
    (fun (content_type, bytes) -> Text_encoding.decode ~content_type bytes)
    (Browse.resource_content client id)
