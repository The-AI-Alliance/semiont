type run = { mutable release : unit -> unit; mutable accepted : bool }

type t = {
  client : Client.t;
  locale : string;
  is_generating : bool State_value.t * bool State_value.writer;
  progress :
    Yojson.Safe.t option State_value.t * Yojson.Safe.t option State_value.writer;
  outcome :
    Yojson.Safe.t option State_value.t * Yojson.Safe.t option State_value.writer;
  failure :
    Delegation.failure option State_value.t
    * Delegation.failure option State_value.writer;
  job_id : string option State_value.t * string option State_value.writer;
  mutable runs : run list;
  mutable selected : run option;
  mutable disposed : bool;
}

let make client ~locale =
  {
    client;
    locale;
    is_generating = State_value.make false;
    progress = State_value.make None;
    outcome = State_value.make None;
    failure = State_value.make None;
    job_id = State_value.make None;
    runs = [];
    selected = None;
    disposed = false;
  }

let is_generating t = fst t.is_generating
let progress t = fst t.progress
let outcome t = fst t.outcome
let failure t = fst t.failure
let job_id t = fst t.job_id
let set state value = State_value.set (snd state) value

let dismiss_progress t =
  if not t.disposed then (
    set t.progress None;
    set t.outcome None;
    set t.failure None)

let generate t ?stall_ms params =
  if not t.disposed then (
    let run = { release = ignore; accepted = false } in
    let previous = t.runs in
    t.runs <- run :: previous;
    List.iter (fun old -> if old.accepted then old.release ()) previous;
    t.selected <- Some run;
    let current () =
      Option.exists (fun selected -> selected == run) t.selected
    in
    dismiss_progress t;
    set t.is_generating false;
    set t.job_id None;
    let params =
      match Yojson.Safe.from_string (Models.encode params) with
      | `Assoc fields
        when List.mem
               (List.assoc_opt "language" fields)
               [ None; Some (`String ""); Some `Null ] ->
          Models.decode Models.generation_job_request
            (Yojson.Safe.to_string
               (`Assoc
                  (("language", `String t.locale)
                  :: List.remove_assoc "language" fields)))
          |> Result.fold ~ok:Fun.id ~error:(fun _ -> params)
      | _ -> params
    in
    run.release <-
      Client.Yield.delegate
        (Client.delegation t.client)
        ?stall_ms ~params
        ~on_report:(fun kind value ->
          let member key = Yojson.Safe.Util.member key value in
          match kind with
          | Delegation.Created ->
              run.accepted <- true;
              if current () then
                set t.job_id
                  (Yojson.Safe.Util.to_string_option (member "jobId"))
              else run.release ()
          | _ when not (current ()) -> ()
          | Progress ->
              set t.progress (Some value);
              set t.is_generating true
          | Complete -> (
              match member "result" with
              | `Assoc _ as result -> set t.outcome (Some result)
              | _ -> ())
          | Retrying | Refused -> ())
        ~on_failure:(fun failure ->
          if current () then (
            set t.failure (Some failure);
            if failure.code <> "job.cancelled" then set t.progress None))
        ~on_close:(fun () ->
          t.runs <- List.filter (fun active -> active != run) t.runs;
          if current () then (
            t.selected <- None;
            set t.is_generating false;
            set t.job_id None))
        ())

let dispose t =
  if not t.disposed then (
    t.disposed <- true;
    List.iter (fun run -> run.release ()) t.runs;
    State_value.close (snd t.is_generating);
    State_value.close (snd t.progress);
    State_value.close (snd t.outcome);
    State_value.close (snd t.failure);
    State_value.close (snd t.job_id))
