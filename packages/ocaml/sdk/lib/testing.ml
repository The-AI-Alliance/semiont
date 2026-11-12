open Eio.Std

type fault_action = Testing_facts.fault_action =
  | Deliver
  | Drop_reply
  | Delay of int
  | Duplicate_reply
  | Reject_emit

type delivery_op = Testing_facts.delivery_op = Write | Transition

type respond =
  channel:string -> Yojson.Safe.t -> (string * Yojson.Safe.t) option

let fault_actions = Testing_facts.fault_actions
let fault_schedules = Testing_facts.fault_schedules

let delivery_ops random ~max_length =
  if max_length < 1 then invalid_arg "delivery schedule must be nonempty";
  let count = 1 + Random.State.int random max_length in
  let operations =
    List.init count (fun _ ->
        if Random.State.bool random then Write else Transition)
  in
  if List.mem Write operations then operations else Write :: List.tl operations

type request_log_entry = {
  channel : string;
  action : fault_action;
  correlation_id : string option;
  retry_key : string;
  payload : Yojson.Safe.t;
}

(* What a stream's subscribe request names: its global channels, and each
   scope's channels. *)
type heard = { global : string list; scoped : (string * string list) list }

type transport = {
  sw : Switch.t;
  clock : Clock.t;
  respond : respond;
  mutable faults : fault_action list;
  mutable log : request_log_entry list;
  mutable next_stream : int;
  streams : (int, heard * string option Eio.Stream.t) Hashtbl.t;
  queued : (string * Yojson.Safe.t) option Queue.t;
}

let transport ~sw ~clock ~schedule ~respond =
  {
    sw;
    clock;
    respond;
    faults = schedule;
    log = [];
    next_stream = 0;
    streams = Hashtbl.create 2;
    queued = Queue.create ();
  }

let request_log t = List.rev t.log
let queue_reply t reply = Queue.add reply t.queued

let deliver t ?id ?correlation_id ?scope channel payload =
  let optional key = Option.map (fun value -> (key, `String value)) in
  let data =
    Yojson.Safe.to_string
      (`Assoc
         (List.filter_map Fun.id
            [
              Some ("channel", `String channel);
              Some ("payload", payload);
              optional "correlationId" correlation_id;
              optional "scope" scope;
            ]))
  in
  let event =
    "event: bus-event\n"
    ^ Option.fold ~none:"" ~some:(fun id -> "id: " ^ id ^ "\n") id
    ^ "data: " ^ data ^ "\n\n"
  in
  let hears { global; scoped } =
    List.mem channel global
    ||
    match Option.bind scope (fun scope -> List.assoc_opt scope scoped) with
    | Some channels -> List.mem channel channels
    | None -> false
  in
  Hashtbl.iter
    (fun _ (heard, stream) ->
      if hears heard then Eio.Stream.add stream (Some event))
    t.streams

let disconnect t =
  Hashtbl.iter (fun _ (_, stream) -> Eio.Stream.add stream None) t.streams

module Source = struct
  type t = string option Eio.Stream.t * string ref

  let read_methods = []

  let single_read (stream, pending) buffer =
    (if !pending = "" then
       pending :=
         match Eio.Stream.take stream with
         | Some event -> event
         | None -> raise End_of_file);
    let length = min (String.length !pending) (Cstruct.length buffer) in
    Cstruct.blit_from_string !pending 0 buffer 0 length;
    pending := String.sub !pending length (String.length !pending - length);
    length
end

let call
    ?(content =
      fun ~meth:_ ~path:_ ~headers:_ ~body:_ ->
        (404, [], Eio.Flow.string_source "{}")) t ~sw ~meth ~path ~headers ~body
    ~progress:_ =
  match path with
  | "/bus/subscribe" ->
      let open Yojson.Safe.Util in
      let request = Yojson.Safe.from_string body in
      let texts value = List.map to_string (to_list value) in
      let heard =
        {
          global = texts (member "global" request);
          scoped =
            List.map
              (fun entry ->
                ( to_string (member "scope" entry),
                  texts (member "channels" entry) ))
              (to_list (member "scoped" request));
        }
      in
      let stream = Eio.Stream.create max_int in
      let key = t.next_stream in
      t.next_stream <- key + 1;
      Hashtbl.add t.streams key (heard, stream);
      Switch.on_release sw (fun () -> Hashtbl.remove t.streams key);
      ( 200,
        [],
        Eio.Resource.T ((stream, ref ""), Eio.Flow.Pi.source (module Source)) )
  | "/bus/emit" -> (
      let open Yojson.Safe.Util in
      let frame = Yojson.Safe.from_string body in
      let channel = to_string (member "channel" frame) in
      let payload = member "payload" frame in
      let correlation_id = to_string_option (member "correlationId" frame) in
      let retry_key =
        Option.value
          (List.assoc_opt "idempotency-key" headers)
          ~default:(Option.value correlation_id ~default:channel)
      in
      let action =
        match t.faults with
        | [] -> Deliver
        | action :: remaining ->
            t.faults <- remaining;
            action
      in
      t.log <- { channel; action; correlation_id; retry_key; payload } :: t.log;
      match action with
      | Reject_emit -> (503, [], Eio.Flow.string_source "{}")
      | Drop_reply -> (202, [], Eio.Flow.string_source "{}")
      | Deliver | Delay _ | Duplicate_reply ->
          let response =
            if Queue.is_empty t.queued then t.respond ~channel payload
            else Queue.take t.queued
          in
          let send () =
            Option.iter
              (fun (reply, payload) ->
                deliver t ?correlation_id reply payload;
                if action = Duplicate_reply then
                  deliver t ?correlation_id reply payload)
              response
          in
          (match action with
          | Delay ms ->
              Fiber.fork_daemon ~sw:t.sw (fun () ->
                  Retry.sleep_ms t.clock (float ms);
                  send ();
                  `Stop_daemon)
          | _ -> send ());
          (202, [], Eio.Flow.string_source "{}"))
  | _ -> content ~meth ~path ~headers ~body

type liveness_scenario = {
  outputs : (unit -> unit) list;
  settlements : (unit -> unit) list;
  requests : unit -> request_log_entry list;
}

type liveness_spec = {
  clock : Clock.t;
  timeout_ms : int;
  retry_budget : int;
  schedules : fault_action list list;
  setup : fault_action list -> (liveness_scenario -> unit) -> unit;
}

let assert_liveness_axioms spec =
  if spec.timeout_ms <= 0 || spec.retry_budget < 0 || spec.schedules = [] then
    invalid_arg "invalid liveness bounds";
  List.iter
    (fun schedule ->
      spec.setup schedule (fun scenario ->
          let delay =
            List.fold_left
              (fun total -> function Delay ms -> total + ms | _ -> total)
              0 schedule
          in
          let budget =
            ((float spec.timeout_ms *. (1. +. float spec.retry_budget))
            +. float delay)
            *. float Testing_facts.slack
          in
          let outputs_done = ref false and settled = ref false in
          Fiber.first
            (fun () ->
              Fiber.both
                (fun () ->
                  Fiber.all scenario.outputs;
                  outputs_done := true)
                (fun () ->
                  Fiber.all scenario.settlements;
                  settled := true))
            (fun () -> Retry.sleep_ms spec.clock budget);
          if not !settled then failwith "L2: a request did not settle";
          let counts = Hashtbl.create 8 in
          List.iter
            (fun entry ->
              let count =
                1
                + Option.value
                    (Hashtbl.find_opt counts entry.retry_key)
                    ~default:0
              in
              Hashtbl.replace counts entry.retry_key count;
              if count - 1 > spec.retry_budget then
                failwith ("L2: retry budget exceeded for " ^ entry.retry_key))
            (scenario.requests ());
          if not !outputs_done then failwith "L1: an output remained pending"))
    spec.schedules

type delivery_subject = {
  write : string -> unit;
  transition : unit -> unit;
  delivered : unit -> string list;
}

let assert_exactly_once_delivery operations setup =
  if not (List.mem Write operations) then
    invalid_arg "delivery schedule contains no write";
  setup (fun subject ->
      let written =
        List.filter_map Fun.id
          (List.mapi
             (fun index -> function
               | Transition ->
                   subject.transition ();
                   None
               | Write ->
                   let id = "e" ^ string_of_int index in
                   subject.write id;
                   Some id)
             operations)
      in
      if subject.delivered () <> written then
        failwith "L3: events were lost, duplicated, or reordered")

type test_session_options = {
  client : Client.t;
  id : string;
  kb : Registry.knowledge_base;
}

type test_session = { session : State_units.Session.t; close : unit -> unit }

let create_test_session options =
  let session =
    State_units.Session.make ~id:options.id ~kb:options.kb options.client
  in
  { session; close = (fun () -> State_units.Session.dispose session) }

let say_on session said =
  let client : Client_record.t = State_units.Session.client session in
  Kept_for_first_reader.say client.said said

type renewal = Session.renewal

type scripted_sessions = {
  builds : (string, Registry.session_factory Queue.t) Hashtbl.t;
  grants : renewal Queue.t;
}

let scripted_sessions () =
  { builds = Hashtbl.create 4; grants = Queue.create () }

let queue_session script id build =
  let queue =
    match Hashtbl.find_opt script.builds id with
    | Some queue -> queue
    | None ->
        let queue = Queue.create () in
        Hashtbl.add script.builds id queue;
        queue
  in
  Queue.add build queue

let factory script (options : Registry.session_factory_options) =
  let id = (Records.Knowledge_base.of_model options.kb).id in
  match Option.bind (Hashtbl.find_opt script.builds id) Queue.take_opt with
  | Some build -> build options
  | None -> Error ("unscripted session " ^ id)

let queue_renewal script renewal = Queue.add renewal script.grants

let renew script ~holding:_ =
  Option.value (Queue.take_opt script.grants) ~default:Session.Refused

type shared_storage = {
  values : (string, string) Hashtbl.t;
  watchers : (int, int * string * (string option -> unit)) Hashtbl.t;
  lock : Eio.Mutex.t;
  mutable serial : int;
}

let shared_storage () =
  {
    values = Hashtbl.create 8;
    watchers = Hashtbl.create 8;
    lock = Eio.Mutex.create ();
    serial = 0;
  }

let locked shared f = Eio.Mutex.use_rw ~protect:false shared.lock f

let fresh shared =
  shared.serial <- shared.serial + 1;
  shared.serial

let storage_context shared =
  let context = locked shared (fun () -> fresh shared) in
  let get key = locked shared (fun () -> Hashtbl.find_opt shared.values key) in
  let update key change =
    let next, listeners =
      locked shared (fun () ->
          let prior = Hashtbl.find_opt shared.values key in
          let next = change prior in
          (match next with
          | Some value -> Hashtbl.replace shared.values key value
          | None -> Hashtbl.remove shared.values key);
          let listeners =
            if prior = next then []
            else
              Hashtbl.fold
                (fun _ (owner, watched, listener) listeners ->
                  if owner <> context && key = watched then
                    listener :: listeners
                  else listeners)
                shared.watchers []
          in
          (next, listeners))
    in
    List.iter (fun listener -> listener next) listeners
  in
  let subscribe key listener =
    let id =
      locked shared (fun () ->
          let id = fresh shared in
          Hashtbl.add shared.watchers id (context, key, listener);
          id)
    in
    fun () -> locked shared (fun () -> Hashtbl.remove shared.watchers id)
  in
  Storage.make ~get ~update ~subscribe ()
