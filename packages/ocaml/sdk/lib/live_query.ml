open Eio.Std

type 'value state = Pending | Ready of 'value | Failed of string

type 'value observer = {
  id : unit ref;
  on_state : 'value state -> unit;
  on_close : unit -> unit;
}

type 'value entry = {
  mutable restored : bool;
  mutable confirmed : bool;
  mutable state : 'value state;
  mutable observers : 'value observer list;
  mutable release : unit -> unit;
  mutable in_flight : ('value, string) result Promise.t option;
  mutable patches : ('value -> 'value) list;
  mutable invalidated : bool;
  mutable trailing : bool ref option;
}

type ('key, 'value) t = {
  sw : Switch.t;
  clock : Clock.t;
  window_ms : int;
  load : 'key -> ('value, string) result;
  hold : 'key -> unit -> unit;
  restore : 'key -> 'value option;
  save : 'key -> 'value option -> unit;
  entries : ('key, 'value entry) Hashtbl.t;
  stopped : unit Promise.t;
  stop : unit Promise.u;
}

let make ?(window_ms = Client_timing.invalidation_window_ms) ~sw ~clock ~load
    ?(restore = fun _ -> None) ?(save = fun _ _ -> ()) ~hold () =
  let stopped, stop = Promise.create () in
  {
    sw;
    clock;
    window_ms;
    load;
    hold;
    restore;
    save;
    entries = Hashtbl.create 8;
    stopped;
    stop;
  }

let entry t key =
  match Hashtbl.find_opt t.entries key with
  | Some entry -> entry
  | None ->
      let restored = t.restore key in
      let entry =
        {
          restored = Option.is_some restored;
          confirmed = false;
          state =
            Option.fold ~none:Pending ~some:(fun value -> Ready value) restored;
          observers = [];
          release = Fun.id;
          in_flight = None;
          patches = [];
          invalidated = false;
          trailing = None;
        }
      in
      Hashtbl.add t.entries key entry;
      entry

let publish entry state =
  entry.state <- state;
  List.iter (fun observer -> observer.on_state state) (List.rev entry.observers)

let store t key entry state =
  entry.confirmed <- (match state with Ready _ -> true | _ -> false);
  t.save key (match state with Ready value -> Some value | _ -> None);
  publish entry state

let held entry =
  match entry with
  | { state = Ready _ | Failed _; _ } | { in_flight = Some _; _ } -> true
  | _ -> false

let settled entry =
  Option.is_none entry.in_flight
  && (not entry.invalidated)
  && Option.fold ~none:true ~some:(fun again -> not !again) entry.trailing

let rec fetch ?(force = false) ?(retry = true) t key entry =
  match entry.in_flight with
  | Some pending when not force -> pending
  | _ ->
      let pending, settle = Promise.create () in
      entry.in_flight <- Some pending;
      entry.patches <- [];
      entry.confirmed <- false;
      (* Only the key's current fetch writes (B9): one that an invalidation, a
         write or a removal let go of answers its own callers. *)
      let current () =
        match entry.in_flight with
        | Some active -> active == pending
        | None -> false
      in
      Fiber.fork ~sw:t.sw (fun () ->
          let result =
            Fiber.first
              (fun () ->
                match t.load key with
                | Error code
                  when retry
                       && code <> Error_codes.Bus_request.closed
                       && current () ->
                    (* The patches kept with the failed ask go with it; the
                       retry is asked after their events (B13b). *)
                    entry.patches <- [];
                    t.load key
                | result -> result)
              (fun () ->
                Promise.await t.stopped;
                Error Error_codes.Bus_request.closed)
          in
          let result =
            if Promise.is_resolved t.stopped || not (current ()) then result
            else (
              entry.in_flight <- None;
              let kept = entry.patches in
              entry.patches <- [];
              let result =
                Result.map
                  (fun value ->
                    List.fold_left (fun value change -> change value) value kept)
                  result
              in
              (match (result, entry.state) with
              | Ok value, _ -> store t key entry (Ready value)
              | Error _, Ready _ -> ()
              | Error reason, _ -> publish entry (Failed reason));
              if entry.invalidated then (
                entry.invalidated <- false;
                ignore (fetch t key entry));
              result)
          in
          Promise.resolve settle result);
      pending

let observe t key ~on_state ~on_close =
  if Promise.is_resolved t.stopped then (
    on_close ();
    Fun.id)
  else
    let entry = entry t key in
    let first = entry.observers = [] in
    let id = ref () in
    entry.observers <- { id; on_state; on_close } :: entry.observers;
    if first then entry.release <- t.hold key;
    (match entry.state with
    | Failed _ when Option.is_none entry.in_flight ->
        publish entry Pending;
        ignore (fetch t key entry)
    | state ->
        on_state state;
        (* A yielding callback can let the pending fetch complete. *)
        if first && (entry.restored || entry.state = Pending) then (
          entry.restored <- false;
          ignore (fetch t key entry)));
    fun () ->
      let prior = entry.observers in
      let remaining = List.filter (fun observer -> observer.id != id) prior in
      entry.observers <- remaining;
      if remaining = [] && prior <> [] then (
        entry.release ();
        entry.release <- Fun.id)

let fresh t key =
  if Promise.is_resolved t.stopped then Error Error_codes.Bus_request.closed
  else Promise.await (fetch ~retry:false t key (entry t key))

let refetch_held t key =
  if not (Promise.is_resolved t.stopped) then
    match Hashtbl.find_opt t.entries key with
    | Some entry when held entry ->
        if Option.is_some entry.in_flight then entry.invalidated <- true
        else ignore (fetch t key entry)
    | _ -> ()

let invalidate t key =
  if not (Promise.is_resolved t.stopped) then
    ignore (fetch ~force:true t key (entry t key))

let refresh t key entry =
  match entry.trailing with
  | Some again -> again := true
  | None ->
      let again = ref false in
      entry.trailing <- Some again;
      let span =
        Mtime.Span.of_uint64_ns
          (Int64.mul (Int64.of_int t.window_ms) 1_000_000L)
      in
      let due =
        Mtime.add_span (Clock.monotonic_now t.clock) span
        |> Option.value ~default:Mtime.max_stamp
      in
      refetch_held t key;
      Fiber.fork ~sw:t.sw (fun () ->
          Fiber.first
            (fun () ->
              Clock.sleep_until t.clock due;
              entry.trailing <- None;
              if !again then refetch_held t key)
            (fun () -> Promise.await t.stopped))

type key = string * string option * string option

let operations =
  List.map
    (fun (query, name) ->
      let operation =
        List.find
          (fun (Bus_registry.Operation op) ->
            Bus_registry.name (Bus_registry.request op) = name)
          Bus_registry.operations
      in
      (query, operation))
    Live_facts.queries

let rec at path value =
  match (path, value) with
  | [], value -> value
  | key :: rest, `Assoc fields ->
      at rest (Option.value (List.assoc_opt key fields) ~default:`Null)
  | _ -> `Null

let rec valid_way valid path value =
  match (path, value) with
  | _, `Null -> true
  | [], value -> valid value
  | key :: rest, `Assoc fields ->
      valid_way valid rest
        (Option.value (List.assoc_opt key fields) ~default:`Null)
  | _ -> false

(* A whole write lets go of the key's fetch in flight and starts none
   (B13b, B13a). *)
let update t key state =
  if not (Promise.is_resolved t.stopped) then (
    let entry = entry t key in
    entry.restored <- false;
    entry.in_flight <- None;
    entry.patches <- [];
    entry.invalidated <- false;
    store t key entry state)

let set t key value = update t key (Ready value)
let remove t key reason = update t key (Failed reason)

(* A patch lets go of nothing (B13b): it is kept with the fetch in flight, to
   be applied to that fetch's reply, and applied at once to the value the key
   holds. It leaves the restored mark and the confirmation as they were. *)
let patch t key change =
  if not (Promise.is_resolved t.stopped) then
    match Hashtbl.find_opt t.entries key with
    | Some entry -> (
        if Option.is_some entry.in_flight then
          entry.patches <- entry.patches @ [ change ];
        match entry.state with
        | Ready value ->
            let patched = change value in
            t.save key (Some patched);
            publish entry (Ready patched)
        | Pending | Failed _ -> ())
    | None -> ()

(* An annotation an event carries, written into its resource's list: in place
   of the one with its id, or at the end. *)
let written_into annotation = function
  | `List values ->
      let id = at [ "id" ] annotation in
      if List.exists (fun prior -> at [ "id" ] prior = id) values then
        `List
          (List.map
             (fun prior -> if at [ "id" ] prior = id then annotation else prior)
             values)
      else `List (values @ [ annotation ])
  | other -> other

let refetch t ~on ~payload =
  let known =
    List.exists
      (fun (channel, _, _, _, _, _, _, _, _) -> channel = on)
      Live_facts.refresh
  in
  if known && not (Promise.is_resolved t.stopped) then
    let valid_id parse = function
      | `String value -> Result.is_ok (parse value)
      | _ -> false
    in
    let valid_payload payload =
      List.for_all
        (fun (trigger, _, _, resource, annotation, _, _, _, _) ->
          trigger <> on
          || (resource = []
             || valid_way
                  (valid_id Identifiers.Resource_id.of_string)
                  resource payload)
             && (annotation = []
                || valid_way
                     (valid_id Identifiers.Annotation_id.of_string)
                     annotation payload))
        Live_facts.refresh
    in
    let trigger, payload =
      match payload with
      | None when on <> "reopened" -> ("unreadable", `Null)
      | None -> (on, `Null)
      | Some payload when valid_payload payload -> (on, payload)
      | Some _ -> ("unreadable", `Null)
    in
    let rules =
      List.filter
        (fun (channel, _, _, _, _, _, _, _, _) -> channel = trigger)
        Live_facts.refresh
    in
    let enriched =
      List.exists
        (fun (_, when_, _, _, _, carries, _, _, _) ->
          when_ = Some "enriched" && at carries payload <> `Null)
        rules
    in
    let name path =
      match at path payload with `String value -> Some value | _ -> None
    in
    let entries = Hashtbl.to_seq t.entries |> List.of_seq in
    List.iter
      (fun (key, entry) ->
        let query, resource, annotation = key in
        if held entry then
          List.iter
            (fun ( _,
                   when_,
                   held,
                   resource_way,
                   annotation_way,
                   carries,
                   queries,
                   writes,
                   removes ) ->
              let applies =
                (match when_ with
                  | Some "enriched" -> enriched
                  | Some "unenriched" -> not enriched
                  | _ -> true)
                && (held
                   || Option.fold ~none:true
                        ~some:(fun value ->
                          resource = None || resource = Some value)
                        (name resource_way)
                      && (List.mem query [ "annotations"; "events" ]
                         || Option.fold ~none:true
                              ~some:(fun value -> annotation = Some value)
                              (name annotation_way)))
              in
              if applies then (
                if List.mem query removes then
                  remove t key Error_codes.Bus_request.not_found;
                (if List.mem query writes then
                   let value = at carries payload in
                   match query with
                   | "annotation" -> set t key value
                   | "annotations" -> patch t key (written_into value)
                   | _ -> ());
                if List.mem query queries then
                  if on = "reopened" then refetch_held t key
                  else refresh t key entry))
            rules)
      entries

let close t =
  if not (Promise.is_resolved t.stopped) then (
    Promise.resolve t.stop ();
    Hashtbl.iter
      (fun _ entry ->
        entry.release ();
        let observers = entry.observers in
        entry.observers <- [];
        List.iter (fun observer -> observer.on_close ()) (List.rev observers))
      t.entries;
    Hashtbl.clear t.entries)

let get t key =
  match Hashtbl.find_opt t.entries key with
  | Some { state = Ready value; _ } -> Some value
  | _ -> None

let known t key =
  match Hashtbl.find_opt t.entries key with
  | Some entry -> held entry
  | None -> false

let keys t =
  Hashtbl.fold
    (fun key _ keys -> if known t key then key :: keys else keys)
    t.entries []

let in_flight t =
  Hashtbl.fold
    (fun _ entry active -> active || Option.is_some entry.in_flight)
    t.entries false

let ready_for_replay t scope changes =
  let belongs (_, resource, _) = resource = Some scope in
  let keys =
    Hashtbl.to_seq t.entries
    |> Seq.filter (fun (key, _) -> belongs key)
    |> List.of_seq
  in
  keys <> []
  && Hashtbl.fold (fun _ entry all -> all && settled entry) t.entries true
  && List.for_all
       (fun (key, entry) -> entry.confirmed && List.mem_assoc key changes)
       keys

let invalidate_all t = List.iter (invalidate t) (keys t)
