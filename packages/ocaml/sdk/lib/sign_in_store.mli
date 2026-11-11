(** POSIX interoperability with the launcher's [tokens.json]. *)

type t
type entry

exception Invalid_store

type platform = Macos | Windows | Other

val state_directory :
  platform:platform ->
  home:string option ->
  xdg_state_home:string option ->
  local_app_data:string option ->
  string option

val make : clock:Clock.t -> directory:string -> t
val find : t -> key:string -> entry option
val access_token : entry -> string
val issuer : entry -> string

val save_device :
  t ->
  key:string ->
  issuer:Oauth.issuer ->
  Oauth.script Oauth.tokens ->
  (unit, Oauth.error) result
(** Saves tokens issued to the script client by a device authorization grant. *)

val remove : t -> key:string -> unit

val renew :
  t -> key:string -> http:Oauth.http -> holding:string option -> Session.renewal

val session : t -> sw:Eio.Switch.t -> key:string -> http:Oauth.http -> Session.t

val sign_out : t -> key:string -> http:Oauth.http -> (bool, Oauth.error) result
(** Removes the entry before attempting issuer revocation. [Ok false] means
    there was no refresh token or revocation endpoint. *)
