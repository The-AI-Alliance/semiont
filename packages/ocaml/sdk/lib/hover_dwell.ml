type t = {
  client : Client.t;
  delay_ms : int;
  task : State_task.t;
  mutable pending : Identifiers.Annotation_id.t option;
  mutable hovered : Identifiers.Annotation_id.t option;
}

let make ?(delay_ms = Client_timing.hover_delay_ms) client =
  {
    client;
    delay_ms;
    task = State_task.make ();
    pending = None;
    hovered = None;
  }

let say t annotation =
  let module B = Bus_registry in
  let value =
    Option.fold ~none:`Null
      ~some:(fun id -> `String (Identifiers.Annotation_id.to_string id))
      annotation
  in
  let payload = Yojson.Safe.to_string (`Assoc [ ("annotationId", value) ]) in
  Client.Beckon.hover t.client
    (Result.get_ok (B.decode B.Channels.beckon_hover payload))

let enter t annotation =
  if (not (State_task.disposed t.task)) && t.pending <> Some annotation then (
    t.pending <- Some annotation;
    let clock = Client.clock t.client in
    let due = State_task.deadline clock t.delay_ms in
    State_task.replace t.task ~sw:(Client.switch t.client) (fun current ->
        Clock.sleep_until clock due;
        if current () && t.hovered <> Some annotation then (
          t.hovered <- Some annotation;
          say t t.hovered)))

let leave t =
  if not (State_task.disposed t.task) then (
    State_task.cancel t.task;
    t.pending <- None;
    if Option.is_some t.hovered then (
      t.hovered <- None;
      say t None))

let dispose t = State_task.dispose t.task
