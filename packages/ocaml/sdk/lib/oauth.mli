(** OAuth exchanges over a caller-owned HTTPS adapter. The adapter encodes
    [form] as application/x-www-form-urlencoded and refuses redirects. *)

type request = { meth : string; url : string; form : (string * string) list }
type http = request -> int * string
type error = Invalid_response | Invalid_redirect | Rejected of string
type script
type browser
type service

type 'grant tokens = private {
  access_token : string;
  refresh_token : string option;
  expires_in : int option;
}

type issuer
type redirect

type device = {
  device_code : string;
  user_code : string;
  verification_uri : string;
  verification_uri_complete : string option;
  expires_in : int;
  interval : int;
}

val discover : http -> issuer:string -> (issuer, error) result
val issuer_url : issuer -> string
val token_endpoint : issuer -> string
val revocation_endpoint : issuer -> string option

val begin_redirect :
  issuer -> random:(int -> string) -> redirect_uri:string -> redirect
(** [random] must return cryptographically secure bytes. *)

val url : redirect -> string

val finish_redirect :
  http ->
  issuer ->
  redirect ->
  callback:string ->
  (browser tokens, error) result

val begin_device : http -> issuer -> (device, error) result

val poll_device : http -> issuer -> device -> (script tokens, error) result
(** One poll. Wait at least [device.interval] seconds between polls and back off
    on [Rejected "slow_down"]. *)

val refresh_script :
  http ->
  token_endpoint:string ->
  refresh_token:string ->
  (script tokens, error) result

val service_secret :
  http ->
  issuer ->
  client_id:string ->
  client_secret:string ->
  (service tokens, error) result

type rsa_key

val rsa_key_of_pem : string -> (rsa_key, error) result
(** Reads an unencrypted RSA PKCS#8 PEM key. *)

val rsa_thumbprint : e:string -> n:string -> string

val service_key :
  http ->
  issuer ->
  clock:Clock.t ->
  jti:(unit -> string) ->
  client_id:string ->
  key:rsa_key ->
  (service tokens, error) result
(** [jti] must supply a fresh unique identifier on every invocation. The host
    initializes Mirage's secure random generator for RSA blinding. *)

val revoke_script :
  http ->
  revocation_endpoint:string ->
  refresh_token:string ->
  (unit, error) result
