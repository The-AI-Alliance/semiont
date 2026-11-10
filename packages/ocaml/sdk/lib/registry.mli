type endpoint = [ `KbEndpoint ] Models.t
(** A registry of endpoints and verified identities over caller-owned storage.
*)

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

type semiont_browser

type activation_error =
  | Unavailable of string
  | Identity_conflict of string
  | Superseded

val new_semiont_browser :
  ?storage:Storage.t -> semiont_browser_config -> semiont_browser

val same_place : endpoint -> endpoint -> bool
val knowledge_bases : semiont_browser -> knowledge_base list
val active_id : semiont_browser -> string option
val active_client : semiont_browser -> Client.t option

val record_sign_in :
  semiont_browser -> signed_in -> (sign_in_outcome, string) result

val describe_connection : Client.t -> (connection_identity, string) result
val activate : semiont_browser -> string -> (Client.t, activation_error) result
val sign_out : semiont_browser -> string -> unit
val session_status : semiont_browser -> string -> kb_session_status

val http_session_factory :
  (session_factory_options -> (Client.t, string) result) -> session_factory

val sort_open_resources : open_resource list -> open_resource list

val apply_tab_checks :
  open_resource list -> (string * tab_check) list -> open_resource list

val knowledge_bases_key : string
val active_key : string
val open_resources_by_kb_key : string
val last_viewed_resource_by_kb_key : string
val session_key : string -> string
val kb_of_session_key : string -> string option
val stored_session : storage -> string -> stored_session option
val store_session : storage -> string -> stored_session -> unit
val clear_stored_session : storage -> string -> unit
val load_knowledge_bases : storage -> knowledge_base list
val save_knowledge_bases : storage -> knowledge_base list -> unit
val open_resources : semiont_browser -> kb_id:string -> open_resource list

val set_open_resources :
  semiont_browser -> kb_id:string -> open_resource list -> unit

val last_viewed : semiont_browser -> kb_id:string -> string option
val set_last_viewed : semiont_browser -> kb_id:string -> string option -> unit
val pending_authorization_key : string

type kept_sign_in = {
  held : unit -> stored_session option;
  keep : stored_session -> unit;
  forget : unit -> unit;
}

val kept_in : storage -> string -> kept_sign_in

val renew_kept :
  semiont_browser ->
  http:Oauth.http ->
  string ->
  holding:string option ->
  Session.renewal
(** Renew the sign-in kept for a knowledge base, handed the token the renewal
    renews (protocol/specs/src/sign-in-store/README.md, Renewing it). *)

val forget_rejected : semiont_browser -> string -> string -> unit
(** Forget the sign-in kept for a knowledge base while its access token is the
    one the gateway rejected. *)

val start_kept_session :
  semiont_browser -> sw:Eio.Switch.t -> http:Oauth.http -> string -> Session.t
(** A session over the sign-in kept for a knowledge base: [renew_kept] renews it
    and [forget_rejected] is told each token the gateway rejects. *)

val begin_sign_in :
  semiont_browser ->
  http:Oauth.http ->
  issuer:string ->
  random:(int -> string) ->
  redirect_uri:string ->
  target:endpoint ->
  ?kb_id:string ->
  ?expected_did:string ->
  ?expected_name:string ->
  unit ->
  (string, Oauth.error) result

val complete_sign_in :
  semiont_browser ->
  http:Oauth.http ->
  callback:string ->
  describe:
    (endpoint -> access:string -> ([ `KbDescription ] Models.t, string) result) ->
  (sign_in_outcome, string) result
(** Consumes the pending sign-in before exchanging the code. [describe] reads
    the verified knowledge-base description using the new credentials. *)
