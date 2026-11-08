open Eio.Std
module B = Bus_registry
module J = Yojson.Safe.Util

let scoped_channels =
  List.filter (fun (B.Channel ch) -> B.audience ch = Some B.Scoped) B.channels

let limits_operations =
  List.filter
    (fun (B.Operation op) ->
      String.ends_with ~suffix:":limits-requested" (B.name (B.request op)))
    B.operations

let request bus http ~client_id ~key operation payload =
  let correlation_id = key () in
  let send () =
    ignore
      (Http_wire.emit http ~client_id ~correlation_id (B.request operation)
         (Yojson.Safe.to_string payload))
  in
  try
    match Subscription.request bus ~correlation_id operation ~send with
    | Ok (Subscription.Result response) ->
        Ok (J.member "response" (Yojson.Safe.from_string (B.encode response)))
    | Ok (Subscription.Failure failure) -> Error (Http_wire.bus_failure failure)
    | Error Subscription.Timeout -> Error "bus.timeout"
    | Error Subscription.Transport_closed -> Error "bus.closed"
    | Error Subscription.Unsubscribed -> Error "bus.unsubscribed"
    | Error _ -> Error "bus.rejected"
  with Http_wire.Failed failure -> Error failure.code

let join_limits engines limits =
  let list = function `List values -> values | _ -> [] in
  let identity entry = J.member "engine" entry in
  let lookup engine =
    List.find_opt (fun limit -> identity limit = identity engine) limits
  in
  `List
    (List.map
       (fun engine ->
         match (engine, lookup engine) with
         | `Assoc fields, Some limit ->
             `Assoc (("limits", J.member "limits" limit) :: fields)
         | _ -> engine)
       (list engines))

let make ?window_ms ?restore ?save ~sw ~clock ~bus ~http ~client_id ~key () =
  let load (name, resource, argument) =
    match List.assoc_opt name Live_query.operations with
    | None when name = "annotations" -> (
        match
          Option.bind resource (fun id ->
              Result.to_option (Identifiers.Resource_id.of_string id))
        with
        | None -> Error "bad-request"
        | Some id -> (
            try
              Ok
                (J.member "annotations"
                   (Yojson.Safe.from_string (Http_wire.annotations http id)))
            with Http_wire.Failed failure -> Error failure.code))
    | None -> Error "bad-request"
    | Some (B.Operation operation) ->
        let field name = Option.map (fun value -> (name, `String value)) in
        let payload =
          match (name, argument) with
          | ("resources" | "matchedResources"), Some encoded ->
              Yojson.Safe.from_string encoded
          | _ ->
              `Assoc
                (List.filter_map Fun.id
                   [
                     field "resourceId" resource; field "annotationId" argument;
                   ])
        in
        let read () = request bus http ~client_id ~key operation payload in
        if name = "engines" then (
          let answer = ref (Error "bus.closed") in
          let limits = ref [] in
          Fiber.both
            (fun () -> answer := read ())
            (fun () ->
              Fiber.all
                (List.map
                   (fun (B.Operation op) () ->
                     match request bus http ~client_id ~key op (`Assoc []) with
                     | Ok response -> (
                         match J.member "limits" response with
                         | `List values -> limits := values @ !limits
                         | _ -> ())
                     | Error _ -> ())
                   limits_operations));
          Result.map
            (fun json -> join_limits (J.member "engines" json) !limits)
            !answer)
        else
          Result.map
            (fun json ->
              match name with
              | "resources" | "matchedResources" -> json
              | name -> J.member name json)
            (read ())
  in
  let hold (_, id, _) =
    match
      Option.bind id (fun id ->
          Result.to_option (Identifiers.Resource_id.of_string id))
    with
    | None -> Fun.id
    | Some resource ->
        Subscription.hold_scope bus { resource; channels = scoped_channels }
  in
  Live_query.make ?window_ms ?restore ?save ~sw ~clock ~load ~hold ()

let on_frame cache = function
  | Ok (Wire_stream.Frame { route; payload; _ }) ->
      let payload =
        Result.to_option payload
        |> Option.map (fun value -> Yojson.Safe.from_string (B.encode value))
      in
      Live_query.refetch cache ~on:route.channel ~payload
  | Error (Wire_stream.Invalid_frame (Some route, _)) ->
      Live_query.refetch cache ~on:route.channel ~payload:None
  | _ -> ()
