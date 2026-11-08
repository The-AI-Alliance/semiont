(** The wire codec boundary for a caller-owned HTTP subscription body. *)

type route = {
  channel : string;
  correlation_id : string option;
  scope : Identifiers.Resource_id.t option;
}

type trace = { parent : string; state : string option }

type frame =
  | Frame : {
      id : string option;
      route : route;
      channel : 'a Bus_registry.channel;
      trace : trace option;
      payload : ('a Bus_registry.decoded, Bus_registry.decode_error) result;
    }
      -> frame

type refusal =
  | Invalid_frame of route option * Models.decode_error
  | Unknown_channel of route

val read : Eio.Buf_read.t -> (frame, refusal) result option
(** Read the next bus event. A refused event is consumed, so the same reader can
    be used for the next event. Returns [None] at end of body. *)

type emit_error =
  | Not_emittable
  | Invalid_payload of Bus_registry.decode_error
  | Invalid_envelope of Models.decode_error

val encode_emit :
  ?scope:Identifiers.Resource_id.t ->
  ?client_id:string ->
  ?correlation_id:string ->
  'a Bus_registry.channel ->
  string ->
  (string, emit_error) result
(** Validate a payload and construct the body for the gateway emit request. *)

type frame_refusal_reason = [ `Lacks | `Malformed ]

type frame_refusal = {
  route : route option;
  member : string;
  reason : frame_refusal_reason;
}

val normalized : (frame, refusal) result -> (frame, frame_refusal) result
val refusal_message : frame_refusal -> string
