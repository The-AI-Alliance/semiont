(** A service account named by a knowledge base's gateway. *)

type proof = Service_token.proof = Secret of string | Key of Oauth.rsa_key

type error =
  | Issuer of Oauth.error
  | Gateway of Http_wire.failure
  | Invalid_identity

type t

val sign_in :
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  issuer:Oauth.issuer ->
  http:Oauth.http ->
  client_id:string ->
  proof:proof ->
  key:(unit -> string) ->
  call:
    (sw:Eio.Switch.t ->
    meth:string ->
    path:string ->
    headers:(string * string) list ->
    body:string ->
    progress:(int -> unit) option ->
    int * (string * string) list * Eio.Flow.source_ty Eio.Resource.t) ->
  unit ->
  (t, error) result
(** The key source provides unique assertion IDs and HTTP idempotency keys. *)

val did : t -> Identifiers.User_id.t
val session : t -> Session.t
val close : t -> unit
