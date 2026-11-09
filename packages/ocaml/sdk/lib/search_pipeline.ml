type search_state = { results : Yojson.Safe.t list; is_searching : bool }
type lookup = string -> (Yojson.Safe.t list option -> unit) -> unit -> unit

type t = {
  sw : Eio.Switch.t;
  clock : Clock.t;
  delay : int;
  lookup : lookup;
  query : string State_value.t;
  query_writer : string State_value.writer;
  state : search_state State_value.t;
  state_writer : search_state State_value.writer;
  task : State_task.t;
  mutable settled : string;
  mutable generation : unit ref;
  mutable release : unit -> unit;
}

let query t = t.query
let state t = t.state
let empty = { results = []; is_searching = false }

let set_query t value =
  if (not (State_task.disposed t.task)) && State_value.get t.query <> value then (
    State_value.set t.query_writer value;
    let trimmed = String.trim value in
    let due = State_task.deadline t.clock t.delay in
    State_task.replace t.task ~sw:t.sw (fun current ->
        Clock.sleep_until t.clock due;
        if current () && trimmed <> t.settled then (
          t.release ();
          t.release <- ignore;
          t.settled <- trimmed;
          let generation = ref () in
          t.generation <- generation;
          if trimmed = "" then State_value.set t.state_writer empty
          else (
            State_value.set t.state_writer { empty with is_searching = true };
            t.release <-
              t.lookup trimmed (fun result ->
                  if
                    (not (State_task.disposed t.task))
                    && t.generation == generation
                  then
                    match result with
                    | None -> ()
                    | Some results ->
                        State_value.set t.state_writer
                          { results; is_searching = false })))))

let make ?(debounce_ms = Client_timing.search_debounce_ms) ?(initial_query = "")
    ~sw ~clock ~search () =
  let query, query_writer = State_value.make "" in
  let state, state_writer = State_value.make empty in
  let t =
    {
      sw;
      clock;
      delay = debounce_ms;
      lookup = search;
      query;
      query_writer;
      state;
      state_writer;
      task = State_task.make ();
      settled = "";
      generation = ref ();
      release = ignore;
    }
  in
  set_query t initial_query;
  t

let dispose t =
  State_task.dispose t.task;
  t.release ();
  t.release <- ignore;
  State_value.close t.query_writer;
  State_value.close t.state_writer
