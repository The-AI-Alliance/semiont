type t = { directory : string; clock : Clock.t }

type entry = {
  token : string;
  refresh_token : string option;
  issuer : string;
  token_endpoint : string;
  expires_at : float option;
  fields : (string * Yojson.Safe.t) list;
}

exception Invalid_store

external try_lock : Unix.file_descr -> bool = "semiont_store_try_flock"

type platform = Macos | Windows | Other

let state_directory ~platform ~home ~xdg_state_home ~local_app_data =
  let nonempty = function
    | Some value when value <> "" -> Some value
    | _ -> None
  in
  Option.map
    (fun home ->
      match platform with
      | Macos -> Filename.concat home "Library/Application Support/semiont"
      | Windows ->
          Option.value (nonempty local_app_data)
            ~default:(home ^ "\\AppData\\Local")
          ^ "\\semiont"
      | Other ->
          Filename.concat
            (Option.value (nonempty xdg_state_home)
               ~default:(Filename.concat home ".local/state"))
            "semiont")
    (nonempty home)

let make ~clock ~directory = { directory; clock }
let file t name = Filename.concat t.directory name
let access_token entry = entry.token
let issuer entry = entry.issuer

let field key fields =
  match List.assoc_opt key fields with
  | Some (`String value) when value <> "" -> Some value
  | _ -> None

let parse_time value =
  match Ptime.of_rfc3339 value with
  | Ok (time, _, _) -> Some (Ptime.to_float_s time)
  | Error _ -> None

let format_time value = Ptime.to_rfc3339 (Option.get (Ptime.of_float_s value))
let ( let* ) = Option.bind

let decode = function
  | `Assoc fields ->
      let* token = field "token" fields in
      let* issuer = field "issuer" fields in
      let* token_endpoint = field "tokenEndpoint" fields in
      let* _ = Option.bind (field "obtainedAt" fields) parse_time in
      let expires_at = Option.bind (field "expiresAt" fields) parse_time in
      Some
        {
          token;
          refresh_token = field "refreshToken" fields;
          issuer;
          token_endpoint;
          expires_at;
          fields;
        }
  | _ -> None

let document t =
  try
    let path = file t "tokens.json" in
    let stat = Unix.lstat path in
    if
      stat.st_kind <> Unix.S_REG
      || stat.st_uid <> Unix.geteuid ()
      || stat.st_perm land 0o077 <> 0
    then raise Invalid_store;
    let body = In_channel.with_open_bin path In_channel.input_all in
    match Strict_json.parse body with
    | Ok (`Assoc _) -> (
        match Yojson.Safe.from_string body with
        | `Assoc entries -> entries
        | _ -> raise Invalid_store)
    | _ -> raise Invalid_store
  with Unix.Unix_error (Unix.ENOENT, _, _) -> []

let lookup entries key = Option.bind (List.assoc_opt key entries) decode
let find t ~key = lookup (document t) key

let rec make_parent path =
  try if not (Sys.is_directory path) then raise Invalid_store
  with Sys_error _ -> (
    let parent = Filename.dirname path in
    if parent = path then raise Invalid_store;
    make_parent parent;
    try Unix.mkdir path Store_policy.directory_mode
    with Unix.Unix_error (Unix.EEXIST, _, _) -> ())

let owned_directory t =
  make_parent (Filename.dirname t.directory);
  (try Unix.mkdir t.directory Store_policy.directory_mode
   with Unix.Unix_error (Unix.EEXIST, _, _) -> ());
  let status = Unix.lstat t.directory in
  if status.st_kind <> Unix.S_DIR || status.st_uid <> Unix.geteuid () then
    raise Invalid_store

let with_lock t f =
  owned_directory t;
  let path = file t "tokens.lock" in
  let open_fd () =
    try
      Unix.openfile path
        [ Unix.O_RDWR; Unix.O_CREAT; Unix.O_EXCL; Unix.O_CLOEXEC ]
        Store_policy.file_mode
    with Unix.Unix_error (Unix.EEXIST, _, _) ->
      if (Unix.lstat path).st_kind <> Unix.S_REG then raise Invalid_store;
      Unix.openfile path [ Unix.O_RDWR; Unix.O_CLOEXEC; Unix.O_NONBLOCK ] 0
  in
  let fd = open_fd () in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      let opened = Unix.fstat fd in
      let named = Unix.lstat path in
      if
        opened.st_kind <> Unix.S_REG
        || opened.st_uid <> Unix.geteuid ()
        || opened.st_nlink <> 1
        || named.st_kind <> Unix.S_REG
        || opened.st_ino <> named.st_ino
        || opened.st_dev <> named.st_dev
      then raise Invalid_store;
      let rec acquire () =
        if not (try_lock fd) then (
          let tick =
            Mtime.add_span (Clock.monotonic_now t.clock) Mtime.Span.(20 * ms)
          in
          Clock.sleep_until t.clock (Option.value tick ~default:Mtime.max_stamp);
          acquire ())
      in
      acquire ();
      Unix.chmod t.directory Store_policy.directory_mode;
      Unix.fchmod fd Store_policy.file_mode;
      f (document t))

let write t entries =
  let path, stream =
    Filename.open_temp_file ~perms:Store_policy.file_mode ~temp_dir:t.directory
      "tokens-" ".tmp"
  in
  let renamed = ref false in
  Fun.protect
    ~finally:(fun () ->
      close_out_noerr stream;
      if not !renamed then Unix.unlink path)
    (fun () ->
      output_string stream (Yojson.Safe.to_string (`Assoc entries));
      output_char stream '\n';
      flush stream;
      Unix.fsync (Unix.descr_of_out_channel stream);
      close_out stream;
      Unix.rename path (file t "tokens.json");
      renamed := true)

let replace entries key fields =
  (key, `Assoc fields) :: List.remove_assoc key entries

let token_fields t (tokens : Oauth.script Oauth.tokens) previous_refresh =
  let now = Clock.wall_now t.clock in
  let optional key value =
    Option.to_list (Option.map (fun value -> (key, `String value)) value)
  in
  let refresh =
    match tokens.refresh_token with
    | Some _ as current -> current
    | None -> previous_refresh
  in
  let expiry =
    Option.map
      (fun seconds -> format_time (now +. float seconds))
      tokens.expires_in
  in
  [
    ("token", `String tokens.access_token);
    ("obtainedAt", `String (format_time now));
  ]
  @ optional "refreshToken" refresh
  @ optional "expiresAt" expiry

let jwt_claims token =
  match String.split_on_char '.' token with
  | [ _; payload; _ ] -> (
      match
        Base64.decode ~pad:false ~alphabet:Base64.uri_safe_alphabet payload
      with
      | Ok text -> (
          try
            match Yojson.Safe.from_string text with
            | `Assoc fields -> fields
            | _ -> []
          with Yojson.Json_error _ -> [])
      | Error _ -> [])
  | _ -> []

let save_device t ~key ~issuer tokens =
  let claims = jwt_claims tokens.Oauth.access_token in
  let issuer_url = Oauth.issuer_url issuer in
  if field "iss" claims <> Some issuer_url then Error Oauth.Invalid_response
  else
    let optional key value =
      Option.to_list (Option.map (fun value -> (key, `String value)) value)
    in
    let fields =
      token_fields t tokens None
      @ [
          ("issuer", `String issuer_url);
          ("tokenEndpoint", `String (Oauth.token_endpoint issuer));
        ]
      @ optional "email" (field "email" claims)
      @ optional "revocationEndpoint" (Oauth.revocation_endpoint issuer)
    in
    with_lock t (fun entries -> write t (replace entries key fields));
    Ok ()

let remove t ~key =
  with_lock t (fun entries ->
      if List.mem_assoc key entries then write t (List.remove_assoc key entries))

let fresh t entry =
  let expiry =
    match entry.expires_at with
    | Some _ as expiry -> expiry
    | None -> Session.token_expiry entry.token
  in
  Option.fold ~none:true
    ~some:(fun expiry -> expiry > Clock.wall_now t.clock)
    expiry

let renew t ~key ~http ~refused =
  match find t ~key with
  | None -> Session.Refused
  | Some prior when Some prior.token <> refused && fresh t prior ->
      Session.Renewed prior.token
  | Some prior -> (
      match prior.refresh_token with
      | None -> Session.Refused
      | Some refresh_token ->
          let result =
            Oauth.refresh_script http ~token_endpoint:prior.token_endpoint
              ~refresh_token
          in
          with_lock t (fun entries ->
              match lookup entries key with
              | None -> Session.Refused
              | Some current
                when current.token <> prior.token
                     || current.refresh_token <> prior.refresh_token ->
                  Session.Renewed current.token
              | Some current -> (
                  match result with
                  | Error failure when Oauth.refresh_refused failure ->
                      Session.Refused
                  | Error _ -> Session.Unavailable
                  | Ok tokens ->
                      let refreshed =
                        token_fields t tokens current.refresh_token
                      in
                      let fields =
                        List.filter
                          (fun (name, _) ->
                            not
                              (List.mem name
                                 [
                                   "token";
                                   "obtainedAt";
                                   "expiresAt";
                                   "refreshToken";
                                 ]))
                          current.fields
                      in
                      write t (replace entries key (refreshed @ fields));
                      Session.Renewed tokens.access_token)))

let session t ~sw ~key ~http =
  let initial_token =
    match find t ~key with
    | Some entry when fresh t entry -> Some entry.token
    | Some _ -> (
        match renew t ~key ~http ~refused:None with
        | Session.Renewed bearer -> Some bearer
        | Session.Refused | Session.Unavailable -> None)
    | None -> None
  in
  let last = ref initial_token in
  let renew ~refused =
    let refused = match refused with Some _ -> refused | None -> !last in
    let outcome = renew t ~key ~http ~refused in
    (match outcome with
    | Session.Renewed bearer -> last := Some bearer
    | _ -> ());
    outcome
  in
  Session.start ~sw ~clock:t.clock ~initial_token ~renew ()

let sign_out t ~key ~http =
  let held =
    with_lock t (fun entries ->
        let held = lookup entries key in
        if List.mem_assoc key entries then
          write t (List.remove_assoc key entries);
        held)
  in
  match held with
  | Some entry -> (
      match (field "revocationEndpoint" entry.fields, entry.refresh_token) with
      | Some revocation_endpoint, Some refresh_token ->
          Result.map
            (fun () -> true)
            (Oauth.revoke_script http ~revocation_endpoint ~refresh_token)
      | _ -> Ok false)
  | None -> Ok false
