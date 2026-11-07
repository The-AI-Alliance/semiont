(* Generated from sdk-telemetry/telemetry.json. Do not edit. *)

[@@@ocamlformat "disable"]

let bus_emit = ("bus.emit:", Telemetry.Producer)
let bus_recv = ("bus.recv:", Telemetry.Consumer)
let content_put = ("content.put", Telemetry.Client)
let content_get = ("content.get", Telemetry.Client)
let content_get_graph = ("content.get_graph", Telemetry.Client)
let content_get_anchored_text = ("content.get_anchored_text", Telemetry.Client)
let content_get_annotations = ("content.get_annotations", Telemetry.Client)
let semiont_bus_sent = "semiont.bus.sent"
let attr_bus_channel = "bus.channel"
let attr_bus_scope = "bus.scope"
let attr_content_format = "content.format"
let attr_content_size_bytes = "content.size_bytes"
let attr_content_stream = "content.stream"
let attr_resource_id = "resource.id"
let attr_thread_id = "thread.id"
