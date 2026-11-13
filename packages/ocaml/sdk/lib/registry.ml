module J = Yojson.Safe.Util

type endpoint = [ `KbEndpoint ] Models.t
type knowledge_base = [ `KnowledgeBase ] Models.t

type storage = {
  read : string -> string option;
  write : string -> string -> unit;
  remove : string -> unit;
}

type stored_session = {
  access : string;
  refresh : string;
  client_id : string;
  token_endpoint : string;
  revocation_endpoint : string option;
}

type expected = { did : string; name : string option }

type connection_identity = {
  did : string;
  description : [ `KbDescription ] Models.t;
}

type signed_in = {
  endpoint : endpoint;
  description : [ `KbDescription ] Models.t;
  session : stored_session;
  kb_id : string option;
  expected_did : string option;
  expected_name : string option;
}

type sign_in_outcome = { kb : knowledge_base; expected : expected option }

type kb_read_verdict =
  | Recorded
  | Conflict of { observed_did : string; observed_name : string }
  | NoVerdict

type kb_session_status = Authenticated | Expired | SignedOut

type open_resource = {
  id : string;
  name : string;
  opened_at : int;
  order : int;
  media_type : string option;
  storage_uri : string option;
}

type tab_check =
  | Gone
  | Ready of { name : string; media_type : string option }
  | Unknown

type session_factory_options = {
  kb : knowledge_base;
  storage : storage;
  signals : State_units.Session_signals.t;
}

type session_factory =
  session_factory_options ->
  (State_units.Session.t * connection_identity, Client.session_error) result

type semiont_browser_config = {
  storage : storage;
  clock : Clock.t;
  fresh_id : unit -> string;
  factory : session_factory;
}

type connection = {
  session : State_units.Session.t;
  signals : State_units.Session_signals.t;
}

type semiont_browser = {
  config : semiont_browser_config;
  lock : Eio.Mutex.t;
  atomic_storage : Storage.t option;
  said : Client.session_error Kept_for_first_reader.t;
  mutable connected : connection option;
  mutable generation : unit ref;
  closed : bool Atomic.t;
}

type activation_error =
  | Unavailable of string
  | Identity_conflict of string
  | Superseded
  | Closed

let knowledge_bases_key = Registry_facts.knowledge_bases_key
let active_key = Registry_facts.active_key
let open_resources_by_kb_key = Registry_facts.open_resources_by_kb_key

let last_viewed_resource_by_kb_key =
  Registry_facts.last_viewed_resource_by_kb_key

let session_key id = Registry_facts.session_prefix ^ id

let kb_of_session_key key =
  let n = String.length Registry_facts.session_prefix in
  if
    String.starts_with ~prefix:Registry_facts.session_prefix key
    && String.length key > n
  then Some (String.sub key n (String.length key - n))
  else None

let text value = `String value
let json = Yojson.Safe.to_string
let object_ = function `Assoc fields -> fields | _ -> []

let optional name fields =
  match List.assoc_opt name fields with
  | Some (`String value) -> Some value
  | _ -> None

let member name value =
  List.assoc_opt name (object_ value) |> Option.value ~default:`Null

let parse text =
  match Strict_json.parse text with
  | Ok _ -> Some (Yojson.Safe.from_string text)
  | Error _ -> None

let decode_session source =
  let open Option.Syntax in
  let* body = parse source in
  let fields = object_ body in
  let* access = optional "access" fields in
  let* refresh = optional "refresh" fields in
  let* client_id = optional "clientId" fields in
  let* token_endpoint = optional "tokenEndpoint" fields in
  Some
    {
      access;
      refresh;
      client_id;
      token_endpoint;
      revocation_endpoint = optional "revocationEndpoint" fields;
    }

let optional_field key value =
  Option.to_list (Option.map (fun value -> (key, text value)) value)

let encode_session session =
  json
    (`Assoc
       ([
          ("access", text session.access);
          ("refresh", text session.refresh);
          ("clientId", text session.client_id);
          ("tokenEndpoint", text session.token_endpoint);
        ]
       @ optional_field "revocationEndpoint" session.revocation_endpoint))

let stored_session (storage : storage) id =
  Option.bind (storage.read (session_key id)) decode_session

let store_session (storage : storage) id session =
  storage.write (session_key id) (encode_session session)

let clear_stored_session (storage : storage) id =
  storage.remove (session_key id)

let load_knowledge_bases (storage : storage) =
  match Option.bind (storage.read knowledge_bases_key) parse with
  | Some (`List values) ->
      List.filter_map
        (fun value ->
          Result.to_option (Models.decode Models.knowledge_base (json value)))
        values
  | _ -> []

let save_knowledge_bases (storage : storage) values =
  storage.write knowledge_bases_key
    ("[" ^ String.concat "," (List.map Models.encode values) ^ "]")

let raw_int raw =
  Yojson.Raw.to_string raw |> Yojson.Safe.from_string |> J.to_int

let same_place a b =
  match (Records.Kb_endpoint.of_model a, Records.Kb_endpoint.of_model b) with
  | Some (Http a), Some (Http b) ->
      a.protocol = b.protocol
      && String.lowercase_ascii a.host = String.lowercase_ascii b.host
      && raw_int a.port = raw_int b.port
  | Some (Local a), Some (Local b) -> a.kb_id = b.kb_id
  | _ -> false

let sort_open_resources tabs =
  List.stable_sort
    (fun a b -> compare (a.order, a.opened_at) (b.order, b.opened_at))
    tabs

let apply_tab_checks tabs checks =
  List.filter_map
    (fun tab ->
      match List.assoc_opt tab.id checks with
      | Some Gone -> None
      | Some (Ready { name; media_type }) -> Some { tab with name; media_type }
      | _ -> Some tab)
    tabs

let new_semiont_browser ?storage config =
  let config =
    match storage with
    | None -> config
    | Some store ->
        {
          config with
          storage =
            {
              read = Storage.get store;
              write = Storage.set store;
              remove = Storage.delete store;
            };
        }
  in
  {
    config;
    atomic_storage = storage;
    lock = Eio.Mutex.create ();
    said = Kept_for_first_reader.make ();
    connected = None;
    generation = ref ();
    closed = Atomic.make false;
  }

let knowledge_bases browser = load_knowledge_bases browser.config.storage
let active_id browser = browser.config.storage.read active_key
let locked browser f = Eio.Mutex.use_rw ~protect:false browser.lock f
let errors browser = Kept_for_first_reader.read browser.said

let active_client browser =
  Option.map
    (fun { session; _ } -> State_units.Session.client session)
    browser.connected

(* The registry is the one reader of a session's errors, from the first thing
   it said, until it ends. *)
let read browser { session; signals } =
  let _release =
    State_units.Session.errors session
      ~on_value:(function
        | Client.Own error -> Kept_for_first_reader.say browser.said error
        | Client.Transport_failure { code; message; _ }
          when code = Error_codes.Transport.forbidden ->
            State_units.Session_signals.notify_permission_denied signals
              ~detail:(Some message)
        | Client.Transport_failure _ -> ())
      ~on_close:ignore
  in
  ()

(* The client closes first, so what its closing flush meets is said before the
   session's errors end. *)
let finish { session; signals } =
  Fun.protect
    ~finally:(fun () ->
      State_units.Session.dispose session;
      State_units.Session_signals.dispose signals)
    (fun () -> Client.close (State_units.Session.client session))

let disconnect browser =
  let connected = browser.connected in
  browser.connected <- None;
  Option.iter finish connected

(* Closed before the lock is taken: the lock is held across the closing flush,
   and an activation begun from within it, or while it is under way, is refused
   without waiting for it. *)
let close browser =
  if not (Atomic.exchange browser.closed true) then (
    locked browser (fun () ->
        browser.generation <- ref ();
        disconnect browser);
    Kept_for_first_reader.close browser.said)

let id kb = (Records.Knowledge_base.of_model kb).id
let did kb = (Records.Knowledge_base.of_model kb).did

let endpoint kb =
  let value = (Records.Knowledge_base.of_model kb).endpoint in
  Result.get_ok (Models.decode Models.kb_endpoint (Yojson.Raw.to_string value))

let describe_connection client =
  match Bus_registry.decode Bus_registry.Channels.browse_kb_requested "{}" with
  | Error _ -> Error Error_codes.Transport.bad_request
  | Ok payload -> (
      (* A refusal that names no code is the knowledge base answering that it
         cannot say what it is; any other failure is not having reached it. *)
      match Client.Browse.kb client payload with
      | Error (Client.Refused code) when code = Error_codes.Bus_request.rejected
        ->
          Error Error_codes.Kb_identity.not_reported
      | Error (Client.Transport Subscription.Unrecognized_failure) ->
          Error Error_codes.Kb_identity.not_reported
      | Error _ -> Error Error_codes.Kb_identity.unreachable
      | Ok reply -> (
          let response =
            Bus_registry.encode reply |> Yojson.Safe.from_string
            |> member "response"
          in
          match Models.decode Models.kb_description (json response) with
          | Error _ -> Error Error_codes.Kb_identity.unreachable
          | Ok description ->
              let domain =
                (Records.Kb_description.of_model description).domain
              in
              if domain = "" then Error Error_codes.Kb_identity.not_reported
              else
                Ok
                  ({ did = Identity.knowledge_base_did domain; description }
                    : connection_identity)))

let with_identity ~id ~endpoint (identity : connection_identity) =
  let info = Records.Kb_description.of_model identity.description in
  let source =
    `Assoc
      [
        ("id", text id);
        ("label", text info.name);
        ("did", text identity.did);
        ("endpoint", Yojson.Safe.from_string (Models.encode endpoint));
      ]
  in
  Result.get_ok (Models.decode Models.knowledge_base (json source))

let record_sign_in browser (signed : signed_in) =
  let info = Records.Kb_description.of_model signed.description in
  if info.domain = "" then Error Error_codes.Kb_identity.not_reported
  else
    let identity =
      {
        did = Identity.knowledge_base_did info.domain;
        description = signed.description;
      }
    in
    locked browser (fun () ->
        let values = knowledge_bases browser in
        let verified =
          List.filter
            (fun kb ->
              same_place (endpoint kb) signed.endpoint && did kb = identity.did)
            values
        in
        let prior =
          match
            List.find_opt (fun kb -> Some (id kb) = signed.kb_id) verified
          with
          | Some _ as match_ -> match_
          | None -> List.nth_opt verified 0
        in
        let key =
          match prior with
          | Some kb -> id kb
          | None -> browser.config.fresh_id ()
        in
        if prior = None && List.exists (fun kb -> id kb = key) values then
          Error "kb.id-conflict"
        else
          let kb = with_identity ~id:key ~endpoint:signed.endpoint identity in
          let values =
            match prior with
            | None -> values @ [ kb ]
            | Some _ ->
                List.map
                  (fun prior -> if id prior = key then kb else prior)
                  values
          in
          let storage = browser.config.storage in
          store_session storage key signed.session;
          save_knowledge_bases storage values;
          storage.write active_key key;
          browser.generation <- ref ();
          disconnect browser;
          let expected =
            Option.map
              (fun did -> { did; name = signed.expected_name })
              signed.expected_did
          in
          Ok { kb; expected })

(* A close begun before the activation is taken refuses it; one begun as the
   previous session ends overtakes it, before the factory is asked. *)
let activate browser key =
  let storage = browser.config.storage in
  let take () =
    locked browser (fun () ->
        if Atomic.get browser.closed then None
        else
          let generation = ref () in
          browser.generation <- generation;
          storage.write active_key key;
          disconnect browser;
          Some generation)
  in
  match if Atomic.get browser.closed then None else take () with
  | None -> Error Closed
  | Some _ when Atomic.get browser.closed -> Error Superseded
  | Some generation -> (
      match List.find_opt (fun kb -> id kb = key) (knowledge_bases browser) with
      | None -> Error (Unavailable "kb.not-found")
      | Some kb -> (
          let signals = State_units.Session_signals.make () in
          match browser.config.factory { kb; storage; signals } with
          | exception failure ->
              let backtrace = Printexc.get_raw_backtrace () in
              State_units.Session_signals.dispose signals;
              Printexc.raise_with_backtrace failure backtrace
          | Error refusal ->
              State_units.Session_signals.dispose signals;
              if not (Atomic.get browser.closed) then
                Kept_for_first_reader.say browser.said refusal;
              Error (Unavailable refusal.Client.code)
          | Ok (session, identity) ->
              let connection = { session; signals } in
              read browser connection;
              locked browser (fun () ->
                  if identity.did <> did kb then (
                    finish connection;
                    Error (Identity_conflict identity.did))
                  else if
                    browser.generation != generation
                    || active_id browser <> Some key
                    || not
                         (List.exists
                            (fun current ->
                              id current = key
                              && did current = did kb
                              && same_place (endpoint current) (endpoint kb))
                            (knowledge_bases browser))
                  then (
                    finish connection;
                    Error Superseded)
                  else (
                    browser.connected <- Some connection;
                    Ok session))))

let session_status browser key =
  match stored_session browser.config.storage key with
  | None -> SignedOut
  | Some session -> (
      match Session.token_expiry session.access with
      | Some expiry when expiry <= Clock.wall_now browser.config.clock ->
          Expired
      | _ -> Authenticated)

let sign_out browser key =
  locked browser (fun () ->
      let storage = browser.config.storage in
      browser.generation <- ref ();
      clear_stored_session storage key;
      if active_id browser = Some key then (
        storage.remove active_key;
        disconnect browser))

let http_session_factory connect options =
  match connect options with
  | Error _ as failure -> failure
  | Ok session -> (
      let client = State_units.Session.client session in
      match describe_connection client with
      | Ok identity -> Ok (session, identity)
      | Error code ->
          Fun.protect
            ~finally:(fun () -> State_units.Session.dispose session)
            (fun () -> Client.close client);
          Error
            {
              Client.code = Error_codes.Session.construct_failed;
              message = "The knowledge base did not say who it is: " ^ code;
            })

let by_kb browser key =
  let storage = browser.config.storage in
  match storage.read key with
  | None -> []
  | Some value -> (
      match parse value with
      | Some (`Assoc fields) -> fields
      | _ -> invalid_arg "invalid registry state document")

let open_resources browser ~kb_id =
  match List.assoc_opt kb_id (by_kb browser open_resources_by_kb_key) with
  | Some (`List tabs) ->
      List.filter_map
        (function
          | `Assoc fields -> (
              match
                ( optional "id" fields,
                  optional "name" fields,
                  List.assoc_opt "openedAt" fields,
                  List.assoc_opt "order" fields )
              with
              | Some id, Some name, Some (`Int opened_at), Some (`Int order)
                when opened_at >= 0 && order >= 0 ->
                  Some
                    {
                      id;
                      name;
                      opened_at;
                      order;
                      media_type = optional "mediaType" fields;
                      storage_uri = optional "storageUri" fields;
                    }
              | _ -> None)
          | _ -> None)
        tabs
      |> sort_open_resources
  | _ -> []

let set_by_kb browser key kb_id value =
  let prior = List.remove_assoc kb_id (by_kb browser key) in
  let fields =
    Option.fold ~none:prior ~some:(fun value -> (kb_id, value) :: prior) value
  in
  browser.config.storage.write key (json (`Assoc fields))

let set_open_resources browser ~kb_id tabs =
  let encode tab =
    `Assoc
      ([
         ("id", text tab.id);
         ("name", text tab.name);
         ("openedAt", `Int tab.opened_at);
         ("order", `Int tab.order);
       ]
      @ optional_field "mediaType" tab.media_type
      @ optional_field "storageUri" tab.storage_uri)
  in
  locked browser (fun () ->
      set_by_kb browser open_resources_by_kb_key kb_id
        (Some (`List (List.map encode tabs))))

let last_viewed browser ~kb_id =
  optional kb_id (by_kb browser last_viewed_resource_by_kb_key)

let set_last_viewed browser ~kb_id resource =
  locked browser (fun () ->
      set_by_kb browser last_viewed_resource_by_kb_key kb_id
        (Option.map text resource))

let pending_authorization_key = Registry_facts.pending_authorization_key

type kept_sign_in = {
  held : unit -> stored_session option;
  keep : stored_session -> unit;
  forget : unit -> unit;
}

let kept_in storage id =
  {
    held = (fun () -> stored_session storage id);
    keep = store_session storage id;
    forget = (fun () -> clear_stored_session storage id);
  }

let change_kept browser id change =
  locked browser (fun () ->
      let key = session_key id in
      match browser.atomic_storage with
      | Some store ->
          let result = ref None in
          Storage.update store key (fun raw ->
              let current = Option.bind raw decode_session in
              let next, value = change current in
              result := Some value;
              if next = current then raw else Option.map encode_session next);
          Option.get !result
      | None ->
          let storage = browser.config.storage in
          let current = stored_session storage id in
          let next, value = change current in
          (if next <> current then
             match next with
             | None -> clear_stored_session storage id
             | Some next -> store_session storage id next);
          value)

let renew_kept browser ~http id ~holding =
  match stored_session browser.config.storage id with
  | None -> Session.Refused
  | Some before
    when Kept_renewal.renewed_elsewhere
           ~now:(Clock.wall_now browser.config.clock)
           ~holding
           ~expiry:(Tokens.token_expiry before.access)
           before.access ->
      Session.Renewed before.access
  | Some before ->
      (* An issuer that rotates refresh tokens spends the old one when it
         answers: the exchange and the write of what it brought run to their
         end, whoever stops waiting. *)
      Eio.Cancel.protect (fun () ->
          let issued =
            Oauth.refresh_kept http ~token_endpoint:before.token_endpoint
              ~client_id:before.client_id ~refresh_token:before.refresh
          in
          change_kept browser id (function
            | None -> (None, Session.Refused)
            | Some current when current <> before ->
                (Some current, Session.Renewed current.access)
            | Some current -> (
                match issued with
                | Ok tokens ->
                    let next =
                      {
                        before with
                        access = tokens.access_token;
                        refresh =
                          Option.value tokens.refresh_token
                            ~default:before.refresh;
                      }
                    in
                    (Some next, Session.Renewed next.access)
                | Error failure when Oauth.refresh_refused failure ->
                    (None, Session.Refused)
                | Error _ -> (Some current, Session.Unavailable))))

let forget_rejected browser id token =
  change_kept browser id (function
    | Some current when current.access = token -> (None, ())
    | current -> (current, ()))

let start_kept_session browser ~sw ~http id =
  Session.start ~keep_on_unavailable:true
    ~on_rejected:(forget_rejected browser id)
    ~sw ~clock:browser.config.clock
    ~initial_token:
      (Option.map
         (fun session -> session.access)
         (stored_session browser.config.storage id))
    ~renew:(renew_kept browser ~http id)
    ()

let begin_sign_in browser ~http ~issuer ~random ~redirect_uri ~target ?kb_id
    ?expected_did ?expected_name () =
  Result.map
    (fun issuer ->
      let redirect = Oauth.begin_redirect issuer ~random ~redirect_uri in
      let fields =
        Oauth.keep_redirect issuer redirect
        @ [ ("target", Yojson.Safe.from_string (Models.encode target)) ]
        @ optional_field "kbId" kb_id
        @ optional_field "expectedDid" expected_did
        @ optional_field "expectedName" expected_name
      in
      locked browser (fun () ->
          browser.config.storage.write pending_authorization_key
            (json (`Assoc fields)));
      Oauth.url redirect)
    (Oauth.discover http ~issuer)

let complete_sign_in browser ~http ~callback ~describe =
  let pending =
    locked browser (fun () ->
        let storage = browser.config.storage in
        let value =
          match browser.atomic_storage with
          | Some store ->
              let taken = ref None in
              Storage.update store pending_authorization_key (fun value ->
                  taken := value;
                  None);
              !taken
          | None ->
              let value = storage.read pending_authorization_key in
              storage.remove pending_authorization_key;
              value
        in
        Option.bind value parse)
  in
  let ( let* ) = Result.bind in
  let required = function
    | Some value -> Ok value
    | None -> Error Error_codes.Sign_in.no_pending
  in
  let* body = required pending in
  let* issuer, redirect = required (Oauth.take_redirect body) in
  let* endpoint =
    Models.decode Models.kb_endpoint (json (member "target" body))
    |> Result.map_error (fun _ -> Error_codes.Sign_in.no_pending)
  in
  let* tokens =
    Oauth.finish_redirect http issuer redirect ~callback
    |> Result.map_error (function
      | Oauth.Rejected { code; _ } -> code
      | Invalid_response -> Error_codes.Sign_in.exchange
      | Invalid_redirect -> "oauth.invalid-redirect")
  in
  let* refresh =
    match tokens.refresh_token with
    | Some value -> Ok value
    | None -> Error Error_codes.Sign_in.exchange
  in
  let* description = describe endpoint ~access:tokens.access_token in
  let fields = object_ body in
  record_sign_in browser
    {
      endpoint;
      description;
      session =
        {
          access = tokens.access_token;
          refresh;
          client_id = Oauth_facts.browser;
          token_endpoint = Oauth.token_endpoint issuer;
          revocation_endpoint = Oauth.revocation_endpoint issuer;
        };
      kb_id = optional "kbId" fields;
      expected_did = optional "expectedDid" fields;
      expected_name = optional "expectedName" fields;
    }
