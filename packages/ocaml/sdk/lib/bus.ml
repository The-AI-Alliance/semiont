type t = Client_core.t

let emit = Client_core.emit

let request client ?timeout_ms operation payload =
  Client_core.request client ?timeout_ms ~normalize_refusals:true operation
    payload

type frame_refusal_reason = Wire_stream.frame_refusal_reason
type frame_refusal = Wire_stream.frame_refusal

let frames client ?(on_unroutable = ignore) receive =
  Client_core.on_frame client (fun event ->
      match Wire_stream.normalized event with
      | Error ({ route = None; _ } as fault) -> on_unroutable fault
      | event -> receive event)

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
