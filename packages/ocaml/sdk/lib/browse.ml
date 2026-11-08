include Namespace_methods.Browse

let resource_content client id =
  Client_core.content (fun () ->
      Http_wire.with_content (Client_core.http client) ~streaming:false id
        (fun ~content_type body ->
          ( content_type,
            Eio.Buf_read.parse_exn ~max_size:max_int Eio.Buf_read.take_all body
          )))

let resource_representation = resource_content

let resource_representation_stream client id read =
  Client_core.content (fun () ->
      Http_wire.with_content (Client_core.http client) ~streaming:true id read)

let resource_graph client id =
  Client_core.content (fun () -> Http_wire.graph (Client_core.http client) id)

let resource_anchored_text client id =
  Client_core.content (fun () ->
      Http_wire.anchored_text (Client_core.http client) id)

let with_resource client name resource =
  Client_core.query client
    (name, Some (Identifiers.Resource_id.to_string resource), None)

let resource client id = with_resource client "resource" id
let annotations client id = with_resource client "annotations" id
let events client id = with_resource client "events" id

let annotation client resource annotation =
  Client_core.query client
    ( "annotation",
      Some (Identifiers.Resource_id.to_string resource),
      Some (Identifiers.Annotation_id.to_string annotation) )

let resources client payload =
  Client_core.query client
    ("resources", None, Some (Bus_registry.encode payload))

let entity_types client = Client_core.query client ("entityTypes", None, None)
let tag_schemas client = Client_core.query client ("tagSchemas", None, None)
let engines client = Client_core.query client ("engines", None, None)
