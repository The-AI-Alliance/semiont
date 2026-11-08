type t
(** A single consumer of the queue. The first [next] starts claiming, and the
    next claim waits for the held job to settle. *)

val make :
  Client_core.t ->
  ?timeout_ms:int ->
  ?trace:(unit -> Wire_stream.trace option) ->
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
