(* A client's representation, apart from Client_core so that Testing can say on
   a client's errors with no public member. *)
type session_error = { code : string; message : string }
type said = Own of session_error | Transport_failure of Http_wire.failure

type t = {
  sw : Eio.Switch.t;
  clock : Clock.t;
  cache : (Live_query.key, Yojson.Safe.t) Live_query.t;
  flush_cache : unit -> unit;
  session : Session.t;
  http : Http_wire.t;
  bus : Subscription.t;
  delegation : Delegation.t;
  client_id : string;
  key : unit -> string;
  on_event : (Wire_stream.frame, Wire_stream.refusal) result -> unit;
  said : said Kept_for_first_reader.t;
  listeners :
    ((Wire_stream.frame, Wire_stream.refusal) result -> unit) ref list ref;
}
