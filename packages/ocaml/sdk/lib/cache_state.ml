type t = {
  cache : (string, Yojson.Safe.t) Live_query.t;
  persistence : bool;
  pending : (string, Yojson.Safe.t option) Hashtbl.t;
  task : State_task.t;
  flush : unit -> unit;
}

let make ~sw ~clock ~load ?restore ?save () =
  let task = State_task.make () in
  let pending = Hashtbl.create 8 in
  let flush () =
    if Hashtbl.length pending > 0 then
      Option.iter
        (fun save ->
          let changes = Hashtbl.to_seq pending |> List.of_seq in
          Hashtbl.clear pending;
          save changes)
        save
  in
  let schedule =
    Option.map
      (fun _ key value ->
        Hashtbl.replace pending key value;
        let due = State_task.deadline clock Client_timing.save_debounce_ms in
        State_task.replace task ~sw (fun current ->
            Clock.sleep_until clock due;
            if current () then flush ()))
      save
  in
  let cache =
    Live_query.make ~sw ~clock ~load ?restore ?save:schedule
      ~hold:(fun _ -> Fun.id)
      ()
  in
  { cache; persistence = Option.is_some save; pending; task; flush }

let observe t = Live_query.observe t.cache
let fetch t = Live_query.fresh t.cache
let get t = Live_query.get t.cache
let known t = Live_query.known t.cache
let keys t = Live_query.keys t.cache
let invalidate t = Live_query.invalidate t.cache
let invalidate_all t = Live_query.invalidate_all t.cache
let remove t = Live_query.remove t.cache
let set t = Live_query.set t.cache
let patch t = Live_query.patch t.cache

let persistence_pending t =
  t.persistence && (Hashtbl.length t.pending > 0 || Live_query.in_flight t.cache)

let dispose t =
  State_task.dispose t.task;
  Live_query.close t.cache;
  t.flush ()
