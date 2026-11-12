module B = Bus_registry
module J = Yojson.Safe.Util

type pending_annotation = { selector : Yojson.Safe.t; motivation : string }

type t = {
  client : Client.t;
  resource : Identifiers.Resource_id.t;
  pending :
    pending_annotation option State_value.t
    * pending_annotation option State_value.writer;
  delegating : string option State_value.t * string option State_value.writer;
  progress :
    Yojson.Safe.t option State_value.t * Yojson.Safe.t option State_value.writer;
  motivation : string option State_value.t * string option State_value.writer;
  failure :
    Delegation.failure option State_value.t
    * Delegation.failure option State_value.writer;
  job_id : string option State_value.t * string option State_value.writer;
  submission : State_task.t;
  quiet : State_task.t;
  silence_ms : int;
  mutable unlisten : unit -> unit;
  mutable release : unit -> unit;
  mutable disposed : bool;
}

let set state value = State_value.set (snd state) value
let pending_annotation t = fst t.pending
let delegating_motivation t = fst t.delegating
let progress t = fst t.progress
let progress_motivation t = fst t.motivation
let failure t = fst t.failure
let job_id t = fst t.job_id
let text value = `String value
let source t = text (Identifiers.Resource_id.to_string t.resource)

let publish t channel fields =
  match B.decode channel (Yojson.Safe.to_string (`Assoc fields)) with
  | Ok value -> Client.publish t.client channel value
  | Error _ -> ()

let make ?(silence_ms = Client_timing.delegate_silence_ms) client ~resource =
  let t =
    {
      client;
      resource;
      pending = State_value.make None;
      delegating = State_value.make None;
      progress = State_value.make None;
      motivation = State_value.make None;
      failure = State_value.make None;
      job_id = State_value.make None;
      submission = State_task.make ();
      quiet = State_task.make ();
      silence_ms;
      unlisten = ignore;
      release = ignore;
      disposed = false;
    }
  in
  let listen channel accept =
    Client.on_channel client channel (fun value ->
        let body = Yojson.Safe.from_string (B.encode value) in
        if J.member "source" body = source t then accept body)
  in
  let request =
    listen B.Channels.mark_requested (fun body ->
        let selector = J.member "selector" body in
        let motivation = J.member "motivation" body |> J.to_string in
        set t.pending (Some { selector; motivation }))
  in
  let submit =
    listen B.Channels.mark_submit (fun body ->
        let fields =
          [
            ("body", J.member "body" body);
            ("motivation", J.member "motivation" body);
            ( "target",
              `Assoc
                [ ("source", source t); ("selector", J.member "selector" body) ]
            );
          ]
        in
        let pending = State_value.get (fst t.pending) in
        State_task.replace t.submission ~sw:(Client.switch client)
          (fun current ->
            let result =
              try
                Client.request client B.Operations.mark_create_request
                  (Yojson.Safe.to_string
                     (`Assoc
                        [ ("resourceId", source t); ("request", `Assoc fields) ]))
                |> Result.map_error (fun _ -> "Annotation submission failed")
              with Http_wire.Failed failure -> Error failure.code
            in
            if current () then
              match result with
              | Ok (Subscription.Result _) ->
                  if State_value.get (fst t.pending) == pending then
                    set t.pending None
              | Ok (Subscription.Failure payload) ->
                  let message =
                    Yojson.Safe.from_string (B.encode payload)
                    |> J.member "message"
                  in
                  publish t B.Channels.mark_create_error
                    [ ("resourceId", source t); ("message", message) ]
              | Error message ->
                  publish t B.Channels.mark_create_error
                    [ ("resourceId", source t); ("message", text message) ]))
  in
  t.unlisten <-
    (fun () ->
      request ();
      submit ());
  t

let cancel_pending t = if not t.disposed then set t.pending None

let dismiss_progress t =
  if not t.disposed then (
    set t.progress None;
    set t.motivation None;
    set t.failure None)

let request_delegate t params =
  if not t.disposed then (
    t.release ();
    dismiss_progress t;
    let body = Yojson.Safe.from_string (Models.encode params) in
    let motivation = J.member "motivation" body |> J.to_string_option in
    set t.delegating motivation;
    set t.motivation motivation;
    let arm () =
      let clock = Client.clock t.client in
      let deadline = State_task.deadline clock t.silence_ms in
      State_task.replace t.quiet ~sw:(Client.switch t.client) (fun current ->
          Clock.sleep_until clock deadline;
          if current () then (
            if State_value.get (fst t.progress) = None then
              set t.progress (Some (`Assoc [ ("percentage", `Int 0) ]));
            Option.iter
              (fun value ->
                publish t B.Channels.mark_delegate_timeout
                  [ ("resourceId", source t); ("motivation", text value) ])
              motivation))
    in
    arm ();
    t.release <-
      Client.Mark.delegate
        (Client.delegation t.client)
        ~resource:t.resource ~params
        ~on_report:(fun kind value ->
          match kind with
          | Delegation.Created ->
              set t.job_id (J.member "jobId" value |> J.to_string_option);
              arm ()
          | Progress ->
              set t.progress (Some value);
              arm ()
          | Retrying -> arm ()
          | Complete | Refused -> ())
        ~on_failure:(fun failure ->
          set t.failure (Some failure);
          if failure.code <> Error_codes.Job.cancelled then (
            set t.progress None;
            set t.motivation None))
        ~on_close:(fun () ->
          State_task.cancel t.quiet;
          set t.delegating None;
          set t.job_id None)
        ())

let dispose t =
  if not t.disposed then (
    t.disposed <- true;
    t.unlisten ();
    t.release ();
    State_task.dispose t.submission;
    State_task.dispose t.quiet;
    State_value.close (snd t.pending);
    State_value.close (snd t.delegating);
    State_value.close (snd t.progress);
    State_value.close (snd t.motivation);
    State_value.close (snd t.failure);
    State_value.close (snd t.job_id))
