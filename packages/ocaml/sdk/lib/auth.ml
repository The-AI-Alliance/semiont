let me client =
  Client_core.content (fun () ->
      Http_wire.current_user (Client_core.http client))

let media_token client id =
  Client_core.content (fun () ->
      Http_wire.media_token (Client_core.http client) id)

let protected_resource_metadata client =
  Client_core.content (fun () ->
      Http_wire.protected_resource_metadata (Client_core.http client))
