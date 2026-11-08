include Namespace_methods.Match

let resources client payload =
  Client_core.query client
    ("matchedResources", None, Some (Bus_registry.encode payload))

let search client payload =
  Running.make (fun () ->
      Client_core.ask client Bus_registry.Operations.match_search_requested
        payload)
