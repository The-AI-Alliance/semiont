type connection_identity = Registry.connection_identity = {
  did : string;
  description : [ `KbDescription ] Models.t;
}

type identity_unverifiable_error = string

type begin_authorization_options = {
  issuer : Oauth.issuer;
  random : int -> string;
  redirect_uri : string;
  target : [ `HttpEndpoint ] Models.t;
  kb_id : string option;
  expected_did : string option;
  expected_name : string option;
}

type pending_authorization = {
  issuer : Oauth.issuer;
  redirect : Oauth.redirect;
  target : [ `HttpEndpoint ] Models.t;
  kb_id : string option;
  expected_did : string option;
  expected_name : string option;
}

let code_challenge = Oauth.code_challenge
let pending_authorization_key = Registry.pending_authorization_key

let begin_authorization (options : begin_authorization_options) =
  let redirect =
    Oauth.begin_redirect options.issuer ~random:options.random
      ~redirect_uri:options.redirect_uri
  in
  {
    issuer = options.issuer;
    redirect;
    target = options.target;
    kb_id = options.kb_id;
    expected_did = options.expected_did;
    expected_name = options.expected_name;
  }

let complete_authorization http pending ~callback =
  Oauth.finish_redirect http pending.issuer pending.redirect ~callback

let describe_connection = Registry.describe_connection
let url pending = Oauth.url pending.redirect

let keep storage pending =
  let optional key value =
    Option.to_list (Option.map (fun text -> (key, `String text)) value)
  in
  let fields =
    Oauth.keep_redirect pending.issuer pending.redirect
    @ [ ("target", Yojson.Safe.from_string (Models.encode pending.target)) ]
    @ optional "kbId" pending.kb_id
    @ optional "expectedDid" pending.expected_did
    @ optional "expectedName" pending.expected_name
  in
  Storage.set storage pending_authorization_key
    (Yojson.Safe.to_string (`Assoc fields))

let take storage =
  let held = ref None in
  Storage.update storage pending_authorization_key (fun stored ->
      held := stored;
      None);
  Option.bind !held (fun source ->
      let open Option.Syntax in
      let* _ = Strict_json.parse source |> Result.to_option in
      let json = Yojson.Safe.from_string source in
      let* issuer, redirect = Oauth.take_redirect json in
      let member key = Yojson.Safe.Util.member key json in
      let text key =
        match member key with `String value -> Some value | _ -> None
      in
      let* target =
        Models.decode Models.http_endpoint
          (Yojson.Safe.to_string (member "target"))
        |> Result.to_option
      in
      Some
        {
          issuer;
          redirect;
          target;
          kb_id = text "kbId";
          expected_did = text "expectedDid";
          expected_name = text "expectedName";
        })
