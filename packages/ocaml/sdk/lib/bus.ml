type t = Client_core.t

let emit = Client_core.emit
let request = Client_core.request
let frames = Client_core.on_frame

let reply_channels_for operation =
  [
    Bus_registry.Channel (Bus_registry.result operation);
    Bus_registry.Channel (Bus_registry.failure operation);
  ]

let persisted_event_types =
  List.filter_map
    (fun (Bus_registry.Channel channel) ->
      match Bus_registry.payload channel with
      | Bus_registry.Recorded _ -> Some (Bus_registry.name channel)
      | _ -> None)
    Bus_registry.channels
