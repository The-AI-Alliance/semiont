type t = {
  session : Session.t;
  http : Http_wire.t;
  bus : Subscription.t;
  delegation : Delegation.t;
  client_id : string;
  key : unit -> string;
}

let connect ?timing ?http_timing ?telemetry ?delegation_silence_ms
    ?delegation_poll_ms ~sw ~clock ~session ~client_id ~key ~call ~global
    ~on_event ~on_error () =
  let http =
    Http_wire.make ?timing:http_timing ?telemetry ~clock ~session ~key ~on_error
      ~call ()
  in
  let follower = ref None in
  let global =
    List.sort_uniq
      (fun (Bus_registry.Channel a) (Bus_registry.Channel b) ->
        String.compare (Bus_registry.name a) (Bus_registry.name b))
      (Delegation.channels @ global)
  in
  let connect =
    Subscription.authenticated
      ~credential:(fun () -> Session.credential session)
      ~renew:(Session.refresh_refused session)
      ~on_refused:(fun status ->
        on_error { Http_wire.code = "unauthorized"; status = Some status })
      (Http_wire.subscribe http)
  in
  let on_event frame =
    Option.iter
      (fun delegation -> Delegation.on_frame delegation frame)
      !follower;
    on_event frame
  in
  let bus =
    Subscription.start ?timing ?telemetry ~sw ~clock ~client_id ~global
      ~scopes:[] ~connect ~on_event ()
  in
  let delegation =
    Delegation.make ?silence_ms:delegation_silence_ms
      ?poll_ms:delegation_poll_ms ~sw ~clock ~subscription:bus ~http ~client_id
      ~correlation_id:key ()
  in
  follower := Some delegation;
  { session; http; bus; delegation; client_id; key }

let session t = t.session
let http t = t.http
let subscription t = t.bus
let delegation t = t.delegation

let emit t ?scope ?correlation_id channel payload =
  Http_wire.emit t.http ~client_id:t.client_id ?scope ?correlation_id channel
    payload

let request t ?timeout_ms operation payload =
  let correlation_id = t.key () in
  let send () =
    ignore (emit t ~correlation_id (Bus_registry.request operation) payload)
  in
  Subscription.request t.bus ?timeout_ms ~correlation_id operation ~send

let close t =
  Fun.protect
    ~finally:(fun () -> Subscription.close t.bus)
    (fun () -> Delegation.close t.delegation)

let await_closed t = Subscription.await_closed t.bus
