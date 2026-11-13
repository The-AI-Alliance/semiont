(* Generated from errors/codes.json. Do not edit. *)

[@@@ocamlformat "disable"]

module Bus_request = struct
  let timeout = "bus.timeout"
  let rejected = "bus.rejected"
  let closed = "bus.closed"
  let not_found = "bus.not-found"
  let unsubscribed = "bus.unsubscribed"
  let peer_unavailable = "bus.peer-unavailable"
  let unauthorized = "bus.unauthorized"
  let none_pending = "bus.none-pending"
end
module Transport = struct
  let unauthorized = "unauthorized"
  let forbidden = "forbidden"
  let not_found = "not-found"
  let conflict = "conflict"
  let bad_request = "bad-request"
  let unprocessable = "unprocessable"
  let rate_limited = "rate-limited"
  let unavailable = "unavailable"
  let error = "error"
end
module Job = struct
  let failed = "job.failed"
  let cancelled = "job.cancelled"
  let stalled = "job.stalled"
end
module Session = struct
  let construct_failed = "session.construct-failed"
  let auth_failed = "session.auth-failed"
  let refresh_exhausted = "session.refresh-exhausted"
  let credential_refused = "session.credential-refused"
  let keep_failed = "session.keep-failed"
  let save_refused = "session.save-refused"
end
module Sign_in = struct
  let no_issuer = "no-issuer"
  let discovery = "discovery"
  let no_pending = "no-pending"
  let state = "state"
  let denied = "denied"
  let expired = "expired"
  let aborted = "aborted"
  let exchange = "exchange"
end
module Kb_identity = struct
  let unreachable = "unreachable"
  let not_reported = "not-reported"
end
