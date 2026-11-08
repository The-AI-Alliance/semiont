let health_check client =
  Client_core.content (fun () -> Http_wire.health (Client_core.http client))

let status client =
  Client_core.content (fun () -> Http_wire.status (Client_core.http client))
