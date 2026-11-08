open Eio.Std

type t = {
  id : string;
  kb : [ `KnowledgeBase ] Models.t;
  client : Client.t;
  token : string option State_value.t * string option State_value.writer;
  user :
    [ `UserResponse ] Models.t option State_value.t
    * [ `UserResponse ] Models.t option State_value.writer;
  stream :
    Subscription.state State_value.t * Subscription.state State_value.writer;
  errors :
    Http_wire.failure option State_value.t
    * Http_wire.failure option State_value.writer;
  ready : unit Promise.t * unit Promise.u;
  tasks : State_task.t;
  mutable unlisten : unit -> unit;
}

let id t = t.id
let kb t = t.kb
let client t = t.client
let token t = fst t.token
let user t = fst t.user
let stream_state t = fst t.stream
let errors t = fst t.errors
let ready t = Promise.await (fst t.ready)

let expires_at t =
  Option.bind
    (Session.credential (Client.session t.client))
    Session.token_expiry

let refresh t ?refused () =
  let session = Client.session t.client in
  let result =
    match refused with
    | Some refused -> Session.refresh_refused session ~refused
    | None -> Session.refresh session
  in
  State_value.set (snd t.token) result;
  result

let make ~id ~kb client =
  let session = Client.session client in
  let bus = Client.subscription client in
  let initial_token = Session.credential session in
  let t =
    {
      id;
      kb;
      client;
      token = State_value.make initial_token;
      user = State_value.make None;
      stream = State_value.make (Subscription.state bus);
      errors = State_value.make None;
      ready = Promise.create ();
      tasks = State_task.make ();
      unlisten = ignore;
    }
  in
  let error failure =
    State_value.set ~repeat:true (snd t.errors) (Some failure)
  in
  let mark_ready () =
    if not (Promise.is_resolved (fst t.ready)) then
      Promise.resolve (snd t.ready) ()
  in
  t.unlisten <- Client.on_error client error;
  State_task.replace t.tasks ~sw:(Client.switch client) (fun current ->
      let rec credentials value =
        State_value.set (snd t.token) value;
        let confirmed, validated =
          match value with
          | None -> (None, None)
          | Some _
            when (not (Session.confirmation_required session))
                 && Option.is_some (State_value.get (fst t.user)) ->
              (value, State_value.get (fst t.user))
          | Some _ -> (
              let used, result =
                Http_wire.confirmed_user (Client.http client)
              in
              match result with
              | Ok body ->
                  ( used,
                    Models.decode Models.user_response body |> Result.to_option
                  )
              | Error { code = "unauthorized"; _ } when used <> value ->
                  Option.iter (fun token -> Session.reject session ~token) used;
                  (used, None)
              | Error _ -> (used, None))
        in
        if current () then
          let latest = Session.credential session in
          if latest <> confirmed then credentials latest
          else (
            State_value.set (snd t.token) latest;
            State_value.set (snd t.user) validated;
            mark_ready ();
            let next = Session.await_credential_change session ~from:latest in
            if next <> latest then credentials next)
      in
      let rec stream state =
        State_value.set (snd t.stream) state;
        if state <> Subscription.Closed then
          stream (Subscription.await_state_change bus ~from:state)
      in
      Fiber.both
        (fun () ->
          let initial = Session.credential session in
          let expired =
            Option.exists
              (fun expiry -> expiry <= Clock.wall_now (Client.clock client))
              (Option.bind initial Session.token_expiry)
          in
          credentials (if expired then Session.refresh session else initial))
        (fun () -> stream (Subscription.state bus)));
  t

let dispose t =
  if not (State_task.disposed t.tasks) then (
    State_task.dispose t.tasks;
    t.unlisten ();
    Session.close (Client.session t.client);
    State_value.set (snd t.token) None;
    State_value.set (snd t.user) None;
    if not (Promise.is_resolved (fst t.ready)) then
      Promise.resolve (snd t.ready) ();
    State_value.close (snd t.token);
    State_value.close (snd t.user);
    State_value.close (snd t.stream);
    State_value.close (snd t.errors))
