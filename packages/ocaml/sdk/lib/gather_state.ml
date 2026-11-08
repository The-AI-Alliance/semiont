module B = Bus_registry
module J = Yojson.Safe.Util

type side = {
  context : Yojson.Safe.t option State_value.t;
  context_writer : Yojson.Safe.t option State_value.writer;
  loading : bool State_value.t;
  loading_writer : bool State_value.writer;
  error : Yojson.Safe.t option State_value.t;
  error_writer : Yojson.Safe.t option State_value.writer;
  task : State_task.t;
}

type t = {
  client : Client.t;
  resource : Identifiers.Resource_id.t;
  annotation_id : Identifiers.Annotation_id.t option State_value.t;
  annotation_writer : Identifiers.Annotation_id.t option State_value.writer;
  annotation : side;
  resource_side : side;
}

let make_side () =
  let context, context_writer = State_value.make None in
  let loading, loading_writer = State_value.make false in
  let error, error_writer = State_value.make None in
  {
    context;
    context_writer;
    loading;
    loading_writer;
    error;
    error_writer;
    task = State_task.make ();
  }

let make client ~resource =
  let annotation_id, annotation_writer = State_value.make None in
  {
    client;
    resource;
    annotation_id;
    annotation_writer;
    annotation = make_side ();
    resource_side = make_side ();
  }

let context t = t.annotation.context
let loading t = t.annotation.loading
let error t = t.annotation.error
let annotation_id t = t.annotation_id
let resource_context t = t.resource_side.context
let resource_loading t = t.resource_side.loading
let resource_error t = t.resource_side.error
let text value = `String value

let run t side operation payload =
  if not (State_task.disposed side.task) then (
    State_value.set side.context_writer None;
    State_value.set side.error_writer None;
    State_value.set side.loading_writer true;
    State_task.replace side.task ~sw:(Client.switch t.client) (fun current ->
        let code value = `Assoc [ ("code", text value) ] in
        let decoded value = Yojson.Safe.from_string (B.encode value) in
        let result =
          try
            match
              Client.request t.client operation (Yojson.Safe.to_string payload)
            with
            | Ok (Subscription.Result payload) ->
                Ok (J.member "response" (decoded payload))
            | Ok (Subscription.Failure payload) ->
                Error
                  (`Assoc
                     (List.filter
                        (fun (name, _) -> name = "message" || name = "code")
                        (J.to_assoc (decoded payload))))
            | Error Subscription.Timeout -> Error (code "bus.timeout")
            | Error _ -> Error (code "bus.closed")
          with Http_wire.Failed failure -> Error (code failure.code)
        in
        if current () then (
          (match result with
          | Ok value -> State_value.set side.context_writer (Some value)
          | Error error -> State_value.set side.error_writer (Some error));
          State_value.set side.loading_writer false)))

let gather_annotation t ?(context_window = 2000) ?include_source_context
    ?include_target_context annotation_id =
  if not (State_task.disposed t.annotation.task) then (
    State_value.set t.annotation_writer (Some annotation_id);
    let optional name value =
      Option.to_list (Option.map (fun value -> (name, `Bool value)) value)
    in
    let options =
      `Assoc
        ([ ("contextWindow", `Int context_window) ]
        @ optional "includeSourceContext" include_source_context
        @ optional "includeTargetContext" include_target_context)
    in
    run t t.annotation B.Operations.gather_requested
      (`Assoc
         [
           ("resourceId", text (Identifiers.Resource_id.to_string t.resource));
           ( "annotationId",
             text (Identifiers.Annotation_id.to_string annotation_id) );
           ("options", options);
         ]))

let gather_resource t ?(depth = 2) ?(max_resources = 10)
    ?(include_content = true) ?(include_summary = false)
    ?(exclude_entity_types = []) resource =
  let options =
    `Assoc
      ([
         ("depth", `Int depth);
         ("maxResources", `Int max_resources);
         ("includeContent", `Bool include_content);
         ("includeSummary", `Bool include_summary);
       ]
      @
      if exclude_entity_types = [] then []
      else
        [ ("excludeEntityTypes", `List (List.map text exclude_entity_types)) ])
  in
  run t t.resource_side B.Operations.gather_resource_requested
    (`Assoc
       [
         ("resourceId", text (Identifiers.Resource_id.to_string resource));
         ("options", options);
       ])

let dispose t =
  let close side =
    State_task.dispose side.task;
    State_value.close side.context_writer;
    State_value.close side.error_writer;
    State_value.close side.loading_writer
  in
  close t.annotation;
  close t.resource_side;
  State_value.close t.annotation_writer
