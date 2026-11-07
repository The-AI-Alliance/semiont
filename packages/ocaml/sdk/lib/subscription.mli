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

type open_error = Retry | No_credential

val encode_subscription : snapshot -> (string, Models.decode_error) result

val start :
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

val state : t -> state
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
