include Namespace_methods.Gather

let referenced_by client id =
  Client_core.query client
    ("referencedBy", Some (Identifiers.Resource_id.to_string id), None)

let annotation client payload =
  Running.make (fun () ->
      Client_core.ask client Bus_registry.Operations.gather_requested payload)
