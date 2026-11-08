include module type of Namespace_methods.Yield

val delegate :
  Delegation.t ->
  ?stall_ms:int ->
  params:[ `GenerationJobRequest ] Models.t ->
  on_report:(Delegation.report_kind -> Yojson.Safe.t -> unit) ->
  on_failure:(Delegation.failure -> unit) ->
  on_close:(unit -> unit) ->
  unit ->
  Delegation.release

val resource :
  Client_core.t ->
  fields:(string * string) list ->
  bytes:string ->
  on_progress:(int -> unit) ->
  Upload.t

val create_from_token :
  Client_core.t ->
  token:string ->
  name:string ->
  content:string ->
  ?archive_original:bool ->
  unit ->
  (string, Client_core.error) result
