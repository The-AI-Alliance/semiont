module B = Bus_registry

type t = {
  client : Client.t;
  resource : Identifiers.Resource_id.t;
  hovered : Identifiers.Annotation_id.t option State_value.t;
  writer : Identifiers.Annotation_id.t option State_value.writer;
  mutable release : unit -> unit;
  mutable disposed : bool;
}

let hovered_annotation_id t = t.hovered

let emit t channel fields =
  if not t.disposed then
    match B.decode channel (Yojson.Safe.to_string (`Assoc fields)) with
    | Ok payload -> Client.publish t.client channel payload
    | Error _ -> ()

let annotation id =
  ("annotationId", `String (Identifiers.Annotation_id.to_string id))

let focus t id =
  emit t B.Channels.beckon_focus
    [
      ("resourceId", `String (Identifiers.Resource_id.to_string t.resource));
      annotation id;
    ]

let make client ~resource =
  let hovered, writer = State_value.make None in
  let t =
    { client; resource; hovered; writer; release = Fun.id; disposed = false }
  in
  let read payload =
    match
      Yojson.Safe.from_string (B.encode payload)
      |> Yojson.Safe.Util.member "annotationId"
    with
    | `String value ->
        Result.to_option (Identifiers.Annotation_id.of_string value)
    | _ -> None
  in
  let hover =
    Client.on_channel client B.Channels.beckon_hover (fun payload ->
        let id = read payload in
        State_value.set writer id;
        Option.iter
          (fun id -> emit t B.Channels.beckon_sparkle [ annotation id ])
          id)
  in
  let click =
    Client.on_channel client B.Channels.browse_click (fun payload ->
        Option.iter (focus t) (read payload))
  in
  t.release <-
    (fun () ->
      hover ();
      click ());
  t

let dispose t =
  if not t.disposed then (
    t.disposed <- true;
    t.release ();
    State_value.close t.writer)
