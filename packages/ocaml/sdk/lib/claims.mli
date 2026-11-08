type t
(** A single consumer of the queue. The first [next] starts claiming, and the
    next claim waits for the held job to settle. *)

val make :
  Client_core.t ->
  ?timeout_ms:int ->
  ?stall_ms:int ->
  ?stall_check_ms:int ->
  ?trace:(unit -> Wire_stream.trace option) ->
  ?on_stalled:(Worker.held -> unit) ->
  ?on_refused:(string option -> unit) ->
  ?on_cancel:(Worker.held -> unit) ->
  [ `JobFilter ] Models.t list ->
  t

val next : t -> Worker.held option
val stop : ?settle:bool -> t -> unit
val job_claim_channels : Bus_registry.packed_channel list
val job_commit_channels : Bus_registry.packed_channel list

val will_retry_after :
  retry_count:int -> max_retries:int -> Enums.Failure_class.t option -> bool

type vitals = {
  last_queued_event_at : float option;
  last_claim_at : float option;
  last_finished_at : float option;
  last_activity_at : float option;
  active_job : (Worker.held * float) option;
  jobs_completed : int;
}

val refused : t -> string option option State_value.t
val stalled : t -> Worker.held option State_value.t
val vitals : t -> vitals
