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
  signals : Session.t option;
  on_error : Http_wire.failure -> unit;
}

type session_factory =
  session_factory_options -> (Client.t * connection_identity, string) result

type semiont_browser_config = {
  storage : storage;
  clock : Clock.t;
  fresh_id : unit -> string;
  factory : session_factory;
  on_error : Http_wire.failure -> unit;
}

type semiont_browser = {
  config : semiont_browser_config;
  lock : Eio.Mutex.t;
  atomic_storage : Storage.t option;
  mutable connected : Client.t option;
  mutable generation : unit ref;
}

type activation_error =
  | Unavailable of string
  | Identity_conflict of string
  | Superseded

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
    connected = None;
    generation = ref ();
  }

let knowledge_bases browser = load_knowledge_bases browser.config.storage
let active_id browser = browser.config.storage.read active_key
let locked browser f = Eio.Mutex.use_rw ~protect:false browser.lock f
let active_client browser = browser.connected

let disconnect browser =
  Option.iter Client.close browser.connected;
  browser.connected <- None

let id kb = (Records.Knowledge_base.of_model kb).id
let did kb = (Records.Knowledge_base.of_model kb).did

let endpoint kb =
  let value = (Records.Knowledge_base.of_model kb).endpoint in
  Result.get_ok (Models.decode Models.kb_endpoint (Yojson.Raw.to_string value))

let describe_connection client =
  match Bus_registry.decode Bus_registry.Channels.browse_kb_requested "{}" with
  | Error _ -> Error "bad-request"
  | Ok payload -> (
      match Client.Browse.kb client payload with
      | Error _ -> Error "kb.identity-unreachable"
      | Ok reply -> (
          let response =
            Bus_registry.encode reply |> Yojson.Safe.from_string
            |> member "response"
          in
          match Models.decode Models.kb_description (json response) with
          | Error _ -> Error "kb.identity-not-reported"
          | Ok description ->
              let domain =
                (Records.Kb_description.of_model description).domain
              in
              if domain = "" then Error "kb.identity-not-reported"
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
  if info.domain = "" then Error "kb.identity-not-reported"
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

let activate browser key =
  let generation, before =
    locked browser (fun () ->
        let generation = ref () in
        browser.generation <- generation;
        (generation, active_id browser))
  in
  match List.find_opt (fun kb -> id kb = key) (knowledge_bases browser) with
  | None -> Error (Unavailable "kb.not-found")
  | Some kb -> (
      let storage = browser.config.storage in
      match
        browser.config.factory
          { kb; storage; signals = None; on_error = browser.config.on_error }
      with
      | Error code -> Error (Unavailable code)
      | Ok (client, identity) ->
          locked browser (fun () ->
              if identity.did <> did kb then (
                Client.close client;
                Error (Identity_conflict identity.did))
              else if
                browser.generation != generation
                || active_id browser <> before
                || not
                     (List.exists
                        (fun current ->
                          id current = key
                          && did current = did kb
                          && same_place (endpoint current) (endpoint kb))
                        (knowledge_bases browser))
              then (
                Client.close client;
                Error Superseded)
              else (
                disconnect browser;
                browser.connected <- Some client;
                storage.write active_key key;
                Ok client)))

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
  | Ok client -> (
      match describe_connection client with
      | Ok identity -> Ok (client, identity)
      | Error code ->
          Client.close client;
          Error code)

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

let start_kept_session browser ~sw ~http id =
  let kept = kept_in browser.config.storage id in
  let credential session = session.access in
  let initial_token = Option.map credential (kept.held ()) in
  let renew ~refused =
    match kept.held () with
    | None -> Session.Refused
    | Some before
      when Option.exists (fun token -> token <> before.access) refused ->
        Session.Renewed before.access
    | Some before ->
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
              | Error _ -> (Some current, Session.Unavailable)))
  in
  let on_rejected token =
    change_kept browser id (function
      | Some current when current.access = token -> (None, ())
      | current -> (current, ()))
  in
  Session.start ~keep_on_unavailable:true ~on_rejected ~sw
    ~clock:browser.config.clock ~initial_token ~renew ()

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
    | None -> Error "oauth.invalid-redirect"
  in
  let* body = required pending in
  let* issuer, redirect = required (Oauth.take_redirect body) in
  let* endpoint =
    Models.decode Models.kb_endpoint (json (member "target" body))
    |> Result.map_error (fun _ -> "oauth.invalid-redirect")
  in
  let* tokens =
    Oauth.finish_redirect http issuer redirect ~callback
    |> Result.map_error (function
      | Oauth.Rejected code -> code
      | Invalid_response -> "oauth.invalid-response"
      | Invalid_redirect -> "oauth.invalid-redirect")
  in
  let* refresh =
    match tokens.refresh_token with
    | Some value -> Ok value
    | None -> Error "oauth.refresh-token-missing"
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
