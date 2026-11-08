val delegate :
  Delegation.t ->
  resource:Identifiers.Resource_id.t ->
  params:[ `MarkJobParams ] Models.t ->
  on_report:(Delegation.report_kind -> Yojson.Safe.t -> unit) ->
  on_failure:(Delegation.failure -> unit) ->
  on_close:(unit -> unit) ->
  unit ->
  unit ->
  unit
