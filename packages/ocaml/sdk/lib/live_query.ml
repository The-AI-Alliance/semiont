open Eio.Std

type 'value state = Pending | Ready of 'value | Failed of string

type 'value observer = {
  id : unit ref;
  on_state : 'value state -> unit;
  on_close : unit -> unit;
}

type 'value entry = {
  mutable state : 'value state;
  mutable observers : 'value observer list;
  mutable release : unit -> unit;
  mutable in_flight : ('value, string) result Promise.t option;
  mutable invalidated : bool;
  mutable trailing : bool ref option;
}

type ('key, 'value) t = {
  sw : Switch.t;
  clock : Clock.t;
  window_ms : int;
  load : 'key -> ('value, string) result;
  hold : 'key -> unit -> unit;
  entries : ('key, 'value entry) Hashtbl.t;
  stopped : unit Promise.t;
  stop : unit Promise.u;
}

let make ?(window_ms = Client_timing.invalidation_window_ms) ~sw ~clock ~load
    ~hold () =
  let stopped, stop = Promise.create () in
  {
    sw;
    clock;
    window_ms;
    load;
    hold;
    entries = Hashtbl.create 8;
    stopped;
    stop;
  }

let entry t key =
  match Hashtbl.find_opt t.entries key with
  | Some entry -> entry
  | None ->
      let entry =
        {
          state = Pending;
          observers = [];
          release = Fun.id;
          in_flight = None;
          invalidated = false;
          trailing = None;
        }
      in
      Hashtbl.add t.entries key entry;
      entry

let publish entry state =
  entry.state <- state;
  List.iter (fun observer -> observer.on_state state) (List.rev entry.observers)

let rec fetch t key entry =
  match entry.in_flight with
  | Some pending -> pending
  | None ->
      let pending, settle = Promise.create () in
      entry.in_flight <- Some pending;
      Fiber.fork ~sw:t.sw (fun () ->
          let result =
            Fiber.first
              (fun () -> t.load key)
              (fun () ->
                Promise.await t.stopped;
                Error "bus.closed")
          in
          entry.in_flight <- None;
          if not (Promise.is_resolved t.stopped) then (
            (match (result, entry.state) with
            | Ok value, _ -> publish entry (Ready value)
            | Error _, Ready _ -> ()
            | Error reason, _ -> publish entry (Failed reason));
            if entry.invalidated then (
              entry.invalidated <- false;
              if entry.observers <> [] then ignore (fetch t key entry)));
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
    on_state entry.state;
    if first then ignore (fetch t key entry);
    fun () ->
      let prior = entry.observers in
      let remaining = List.filter (fun observer -> observer.id != id) prior in
      entry.observers <- remaining;
      if remaining = [] && prior <> [] then (
        entry.release ();
        entry.release <- Fun.id)

let fresh t key =
  if Promise.is_resolved t.stopped then Error "bus.closed"
  else Promise.await (fetch t key (entry t key))

let invalidate t key =
  if not (Promise.is_resolved t.stopped) then
    match Hashtbl.find_opt t.entries key with
    | Some entry when entry.observers <> [] ->
        if Option.is_some entry.in_flight then entry.invalidated <- true
        else ignore (fetch t key entry)
    | _ -> ()

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
      invalidate t key;
      Fiber.fork ~sw:t.sw (fun () ->
          Fiber.first
            (fun () ->
              Clock.sleep_until t.clock due;
              entry.trailing <- None;
              if !again then invalidate t key)
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

let channels =
  List.filter
    (fun (Bus_registry.Channel channel) ->
      Bus_registry.audience channel = Some Bus_registry.Everyone
      && List.exists
           (fun (trigger, _, _, _, _, _, _) ->
             trigger = Bus_registry.name channel)
           Live_facts.refresh)
    Bus_registry.channels

let rec at path value =
  match (path, value) with
  | [], value -> value
  | key :: rest, `Assoc fields ->
      at rest (Option.value (List.assoc_opt key fields) ~default:`Null)
  | _ -> `Null

let refetch t ~on ~payload =
  let known =
    List.exists
      (fun (channel, _, _, _, _, _, _) -> channel = on)
      Live_facts.refresh
  in
  if known && not (Promise.is_resolved t.stopped) then
    let trigger, payload =
      match payload with
      | None when on <> "reopened" -> ("unreadable", `Null)
      | None -> (on, `Null)
      | Some payload -> (on, payload)
    in
    let rules =
      List.filter
        (fun (channel, _, _, _, _, _, _) -> channel = trigger)
        Live_facts.refresh
    in
    let enriched =
      List.exists
        (fun (_, when_, _, _, _, carries, _) ->
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
        if
          entry.observers <> []
          && List.exists
               (fun (_, when_, held, resource_way, annotation_way, _, queries)
                  ->
                 List.mem query queries
                 && (match when_ with
                   | Some "enriched" -> enriched
                   | Some "unenriched" -> not enriched
                   | _ -> true)
                 && (held
                    || Option.fold ~none:true
                         ~some:(fun value -> resource = Some value)
                         (name resource_way)
                       && Option.fold ~none:true
                            ~some:(fun value -> annotation = Some value)
                            (name annotation_way)))
               rules
        then if on = "reopened" then invalidate t key else refresh t key entry)
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
