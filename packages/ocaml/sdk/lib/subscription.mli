(** A subscription over a caller-supplied Eio HTTP opener. The transport and its
    callbacks belong to the Eio domain on which it is started. *)

type t

type state =
  | Initial
  | Connecting
  | Open
  | Reconnecting
  | Degraded
  | Unauthenticated
  | Closed

type scope = {
  resource : Identifiers.Resource_id.t;
  channels : Bus_registry.packed_channel list;
}

type snapshot = {
  client_id : string;
  global : Bus_registry.packed_channel list;
  scoped : (scope * string option) list;
  pending_replies : string list;
}

type timing = {
  stream_open_timeout_ms : int;
  reconnect_ms : int;
  max_reconnect_ms : int;
  degraded_threshold_ms : int;
  reconnect_debounce_ms : int;
  lazy_remove_ms : int;
  linger_ms : int;
  bus_request_timeout_ms : int;
}

val default_timing : timing

type open_error = Retry | Retry_after of int | No_credential

type credential_error =
  | Connect_failed
  | Connect_retry_after of int
  | Credential_refused of int

val authenticated :
  credential:(unit -> string option) ->
  renew:(refused:string -> string option) ->
  on_refused:(int -> unit) ->
  (sw:Eio.Switch.t ->
  snapshot ->
  bearer:string ->
  (Eio.Buf_read.t, credential_error) result) ->
  sw:Eio.Switch.t ->
  snapshot ->
  (Eio.Buf_read.t, open_error) result
(** Adapt an HTTP opener that reports refused credentials. [renew] is called
    once with the refused bearer and updates [credential] when it succeeds. A
    repeated refusal is reported and that bearer is held back until replaced. *)

val encode_subscription : snapshot -> (string, Models.decode_error) result

val start :
  ?timing:timing ->
  ?telemetry:Telemetry.t ->
  sw:Eio.Switch.t ->
  clock:Clock.t ->
  client_id:string ->
  global:Bus_registry.packed_channel list ->
  scopes:scope list ->
  connect:(sw:Eio.Switch.t -> snapshot -> (Eio.Buf_read.t, open_error) result) ->
  on_event:((Wire_stream.frame, Wire_stream.refusal) result -> unit) ->
  unit ->
  t
(** The opener returns a subscription response body owned by its switch. A
    retryable refusal or connection error is reported as [Retry]. *)

val hold_scope : t -> scope -> unit -> unit
(** Hold the listed channels on a resource. The returned function releases that
    hold once. A replacement opens before the current stream is retired. *)

val state : t -> state
val await_state_change : t -> from:state -> state
val close : t -> unit
val await_closed : t -> unit

type ('result, 'failure) reply =
  | Result of 'result Bus_registry.decoded
  | Failure of 'failure Bus_registry.decoded

type request_error =
  | Transport_closed
  | Timeout
  | Duplicate_id
  | Unsubscribed
  | Unrecognized_failure
  | Invalid_reply of Bus_registry.decode_error
  | Invalid_frame of Models.decode_error

val request :
  t ->
  ?timeout_ms:int ->
  correlation_id:string ->
  ('request, 'result, 'failure) Bus_registry.operation ->
  send:(unit -> unit) ->
  (('result, 'failure) reply, request_error) result
(** Track a reply before calling [send], once the stream is open. The deadline
    includes the wait for the stream and the send. Cancellation removes the
    pending id and propagates to the caller. *)
