type request = { meth : string; url : string; form : (string * string) list }
type http = request -> int * string
type error = Invalid_response | Invalid_redirect | Rejected of string
type script
type browser
type service

type 'grant tokens = {
  access_token : string;
  refresh_token : string option;
  expires_in : int option;
}

type issuer = {
  issuer : string;
  authorization : string;
  token : string;
  device : string option;
  revocation : string option;
}

type redirect = {
  token_url : string;
  location : string;
  redirect_uri : string;
  state : string;
  verifier : string;
}

type device = {
  device_code : string;
  user_code : string;
  verification_uri : string;
  verification_uri_complete : string option;
  expires_in : int;
  interval : int;
}

let ( let* ) = Result.bind

let member key = function
  | `Assoc fields -> List.assoc_opt key fields
  | _ -> None

let string key json =
  match member key json with
  | Some (`String value) when value <> "" -> Some value
  | _ -> None

let seconds key json =
  match member key json with
  | Some (`Int value) when value > 0 -> Some value
  | _ -> None

let required = function
  | Some value -> Ok value
  | None -> Error Invalid_response

let decode body =
  try Ok (Yojson.Safe.from_string body)
  with Yojson.Json_error _ -> Error Invalid_response

let endpoint value =
  let uri = Uri.of_string value in
  let host = Uri.host uri in
  if Uri.userinfo uri <> None || Uri.fragment uri <> None || host = None then
    None
  else
    match Uri.scheme uri with
    | Some "https" -> Some value
    | Some "http"
      when List.mem host [ Some "localhost"; Some "127.0.0.1"; Some "::1" ] ->
        Some value
    | _ -> None

let exchange http request =
  let status, body = http request in
  let* json = decode body in
  if status >= 200 && status < 300 then Ok json
  else
    match string "error" json with
    | Some code
      when List.mem code
             [
               "authorization_pending";
               "slow_down";
               "access_denied";
               "expired_token";
               "invalid_grant";
               "invalid_client";
             ] ->
        Error (Rejected code)
    | _ -> Error (Rejected "oauth.request-failed")

let discover http ~issuer =
  let* issuer = required (endpoint issuer) in
  let* () =
    if Uri.query (Uri.of_string issuer) = [] then Ok ()
    else Error Invalid_response
  in
  let base =
    if String.ends_with ~suffix:"/" issuer then
      String.sub issuer 0 (String.length issuer - 1)
    else issuer
  in
  let* json =
    exchange http
      {
        meth = "GET";
        url = base ^ "/.well-known/openid-configuration";
        form = [];
      }
  in
  let get name = Option.bind (string name json) endpoint in
  if string "issuer" json <> Some issuer then Error Invalid_response
  else
    let* authorization = required (get "authorization_endpoint") in
    let* token = required (get "token_endpoint") in
    Ok
      {
        issuer;
        authorization;
        token;
        device = get "device_authorization_endpoint";
        revocation = get "revocation_endpoint";
      }

let url redirect = redirect.location
let issuer_url issuer = issuer.issuer
let token_endpoint issuer = issuer.token
let revocation_endpoint issuer = issuer.revocation

let encoded bytes =
  Base64.encode_exn ~pad:false ~alphabet:Base64.uri_safe_alphabet bytes

let begin_redirect issuer ~random ~redirect_uri =
  let draw () =
    let bytes = random 32 in
    if String.length bytes <> 32 then
      invalid_arg "OAuth random source returned the wrong number of bytes";
    encoded bytes
  in
  let verifier = draw () in
  let state = draw () in
  let challenge =
    Digestif.SHA256.(to_raw_string (digest_string verifier)) |> encoded
  in
  let authorization = Uri.of_string issuer.authorization in
  let location =
    Uri.add_query_params' authorization
      [
        ("response_type", "code");
        ("client_id", Oauth_facts.browser);
        ("redirect_uri", redirect_uri);
        ("scope", Oauth_facts.scope);
        ("state", state);
        ("code_challenge", challenge);
        ("code_challenge_method", "S256");
      ]
    |> Uri.to_string
  in
  { location; redirect_uri; state; verifier; token_url = issuer.token }

let grant http ~token_endpoint form =
  let* url = required (endpoint token_endpoint) in
  let* json = exchange http { meth = "POST"; url; form } in
  let* access_token = required (string "access_token" json) in
  Ok
    {
      access_token;
      refresh_token = string "refresh_token" json;
      expires_in = seconds "expires_in" json;
    }

let finish_redirect http issuer redirect ~callback =
  let callback = Uri.of_string callback in
  let param name =
    match List.assoc_opt name (Uri.query callback) with
    | Some [ value ] -> Some value
    | _ -> None
  in
  let address uri = Uri.with_query (Uri.with_fragment uri None) [] in
  match (param "state", param "code") with
  | Some state, Some code
    when state = redirect.state && code <> ""
         && issuer.token = redirect.token_url
         && address callback = address (Uri.of_string redirect.redirect_uri) ->
      grant http ~token_endpoint:issuer.token
        [
          ("grant_type", "authorization_code");
          ("client_id", Oauth_facts.browser);
          ("code", code);
          ("redirect_uri", redirect.redirect_uri);
          ("code_verifier", redirect.verifier);
        ]
  | _ -> Error Invalid_redirect

let begin_device http issuer =
  let* url = required issuer.device in
  let* json =
    exchange http
      {
        meth = "POST";
        url;
        form =
          [ ("client_id", Oauth_facts.script); ("scope", Oauth_facts.scope) ];
      }
  in
  let* device_code = required (string "device_code" json) in
  let* user_code = required (string "user_code" json) in
  let* verification_uri =
    required (Option.bind (string "verification_uri" json) endpoint)
  in
  let* expires_in = required (seconds "expires_in" json) in
  Ok
    {
      device_code;
      user_code;
      verification_uri;
      verification_uri_complete =
        Option.bind (string "verification_uri_complete" json) endpoint;
      expires_in;
      interval = Option.value (seconds "interval" json) ~default:5;
    }

let poll_device http issuer device =
  grant http ~token_endpoint:issuer.token
    [
      ("grant_type", "urn:ietf:params:oauth:grant-type:device_code");
      ("client_id", Oauth_facts.script);
      ("device_code", device.device_code);
    ]

let refresh_script http ~token_endpoint ~refresh_token =
  grant http ~token_endpoint
    [
      ("grant_type", "refresh_token");
      ("client_id", Oauth_facts.script);
      ("refresh_token", refresh_token);
    ]

let service_secret http issuer ~client_id ~client_secret =
  grant http ~token_endpoint:issuer.token
    [
      ("grant_type", "client_credentials");
      ("client_id", client_id);
      ("client_secret", client_secret);
    ]

type rsa_key = X509.Private_key.t

let rsa_key_of_pem pem =
  let trimmed = String.trim pem in
  if
    not
      (String.starts_with ~prefix:"-----BEGIN PRIVATE KEY-----" trimmed
      && String.ends_with ~suffix:"-----END PRIVATE KEY-----" trimmed)
  then Error Invalid_response
  else
    match X509.Private_key.decode_pem trimmed with
    | Ok (`RSA _ as key) -> Ok key
    | _ -> Error Invalid_response

let unsigned z =
  let little = Z.to_bits z in
  let length = ref (String.length little) in
  while !length > 0 && little.[!length - 1] = '\000' do
    decr length
  done;
  String.init !length (fun index -> little.[!length - index - 1]) |> encoded

let rsa_thumbprint ~e ~n =
  Yojson.Safe.to_string
    (`Assoc [ ("e", `String e); ("kty", `String "RSA"); ("n", `String n) ])
  |> Digestif.SHA256.digest_string |> Digestif.SHA256.to_raw_string |> encoded

let assertion_claims ~client_id ~token_endpoint ~issued_at ~jti =
  `Assoc
    [
      ("iss", `String client_id);
      ("sub", `String client_id);
      ("aud", `String token_endpoint);
      ("jti", `String jti);
      ("iat", `Int issued_at);
      ("exp", `Int (issued_at + Assertion_facts.lifetime_seconds));
    ]

let service_key http issuer ~clock ~jti ~client_id ~key =
  match X509.Private_key.public key with
  | `RSA public -> (
      let kid = rsa_thumbprint ~e:(unsigned public.e) ~n:(unsigned public.n) in
      let header = `Assoc [ ("alg", `String "RS256"); ("kid", `String kid) ] in
      let issued_at = int_of_float (floor (Clock.wall_now clock)) in
      let claims =
        assertion_claims ~client_id ~token_endpoint:issuer.token ~issued_at
          ~jti:(jti ())
      in
      let jwt_segment json = encoded (Yojson.Safe.to_string json) in
      let message = jwt_segment header ^ "." ^ jwt_segment claims in
      match
        X509.Private_key.sign `SHA256 ~scheme:`RSA_PKCS1 key (`Message message)
      with
      | Error _ -> Error Invalid_response
      | Ok signature ->
          grant http ~token_endpoint:issuer.token
            [
              ("grant_type", Assertion_facts.grant_type);
              ("client_assertion_type", Assertion_facts.assertion_type);
              ("client_assertion", message ^ "." ^ encoded signature);
            ])
  | _ -> Error Invalid_response

let revoke_script http ~revocation_endpoint ~refresh_token =
  let* url = required (endpoint revocation_endpoint) in
  let status, _ =
    http
      {
        meth = "POST";
        url;
        form =
          [
            ("client_id", Oauth_facts.script);
            ("token_type_hint", "refresh_token");
            ("token", refresh_token);
          ];
      }
  in
  if status = 200 then Ok () else Error (Rejected "oauth.revocation-failed")
