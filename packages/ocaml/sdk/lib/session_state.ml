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
  said : Client.said Kept_for_first_reader.t;
  ready : unit Promise.t * unit Promise.u;
  tasks : State_task.t;
  mutable unlisten : unit -> unit;
  mutable confirmed : [ `UserResponse ] Models.t option;
}

let id t = t.id
let kb t = t.kb
let client t = t.client
let token t = fst t.token
let user t = fst t.user
let stream_state t = fst t.stream
let errors t = Kept_for_first_reader.read t.said
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
  let held = Session.credential session in
  State_value.set (snd t.token) held;
  State_value.set (snd t.user) (if held = None then None else t.confirmed);
  result

type end_reason = Expired | Refused

let make ?(on_auth_failed = ignore) ~id ~kb client =
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
      said = Kept_for_first_reader.make ();
      ready = Promise.create ();
      tasks = State_task.make ();
      unlisten = ignore;
      confirmed = None;
    }
  in
  let say = Kept_for_first_reader.say t.said in
  t.unlisten <- Client.errors client ~on_value:say ~on_close:ignore;
  let own code message = say (Client.Own { code; message }) in
  let auth_failed () =
    own "session.auth-failed"
      "The stored credential could not be validated at startup"
  in
  let refresh_exhausted () =
    own "session.refresh-exhausted" "The session could not be renewed"
  in
  let check token :
      [ `Confirmed of [ `UserResponse ] Models.t | `Refused | `Unavailable ] =
    match Http_wire.check_user (Client.http client) token with
    | Ok body -> (
        match Models.decode Models.user_response body with
        | Ok user -> `Confirmed user
        | Error _ -> `Unavailable)
    | Error { code = "unauthorized"; _ } -> `Refused
    | Error _ -> `Unavailable
  in
  let refresh_context = ref `Running in
  let validate ~current ~refused outcome =
    match outcome with
    | Session.Renewed token when refused <> None || t.confirmed = None -> (
        match check token with
        | _ when not (current ()) -> outcome
        | `Confirmed user ->
            t.confirmed <- Some user;
            outcome
        | `Unavailable ->
            if t.confirmed = None then auth_failed ();
            outcome
        | `Refused ->
            Session.forget session token;
            t.confirmed <- None;
            own "session.credential-refused"
              "The gateway refused a token the issuer had just issued";
            on_auth_failed Refused;
            Session.Refused)
    | Session.Refused when refused <> None ->
        t.confirmed <- None;
        refresh_exhausted ();
        on_auth_failed Expired;
        outcome
    | Session.Unavailable ->
        if !refresh_context = `Expired then auth_failed ()
        else refresh_exhausted ();
        outcome
    | _ -> outcome
  in
  Session.manage session validate;
  State_task.replace t.tasks ~sw:(Client.switch client) (fun current ->
      let rec credentials held =
        if current () then (
          State_value.set (snd t.token) held;
          State_value.set (snd t.user)
            (if held = None then None else t.confirmed);
          if not (Promise.is_resolved (fst t.ready)) then
            Promise.resolve (snd t.ready) ();
          let next = Session.await_credential_change session ~from:held in
          if next <> held then credentials next)
      in
      let rec stream state =
        State_value.set (snd t.stream) state;
        if state <> Subscription.Closed then
          stream (Subscription.await_state_change bus ~from:state)
      in
      let initialize () =
        (match initial_token with
        | None -> ()
        | Some token
          when Option.exists
                 (fun expiry -> expiry <= Clock.wall_now (Client.clock client))
                 (Session.token_expiry token) ->
            refresh_context := `Expired;
            ignore (Session.refresh_outcome session)
        | Some token -> (
            match check token with
            | `Confirmed user -> t.confirmed <- Some user
            | `Unavailable -> auth_failed ()
            | `Refused ->
                ignore (Session.refresh_refused session ~refused:token)));
        refresh_context := `Running;
        credentials (Session.credential session)
      in
      Fiber.both initialize (fun () -> stream (Subscription.state bus)));
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
    Kept_for_first_reader.close t.said)
