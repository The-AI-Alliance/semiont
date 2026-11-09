type proof = Secret of string | Key of Oauth.rsa_key
type failure = { error : Oauth.error; status : int option }
type service_token

val make :
  clock:Clock.t ->
  http:Oauth.http ->
  authority:string ->
  client_id:string ->
  proof:proof ->
  jti:(unit -> string) ->
  unit ->
  service_token

val token : service_token -> (string, failure) result
val renew : service_token -> refused:string -> (string, failure) result
val authorization : service_token -> (string, failure) result
val dispose : service_token -> unit

val grant :
  clock:Clock.t ->
  http:Oauth.http ->
  issuer:Oauth.issuer ->
  client_id:string ->
  proof:proof ->
  jti:(unit -> string) ->
  (Oauth.service Oauth.tokens, Oauth.error) result
