(* Generated from OpenAPI paths, error codes and retry cases. Do not edit. *)

[@@@ocamlformat "disable"]

let subscribe = ("POST", "/bus/subscribe")
let emit = ("POST", "/bus/emit")
let health = ("GET", "/api/health")
let status = ("GET", "/api/status")
let current_user = ("GET", "/api/users/me")
let protected_resource_metadata = ("GET", "/.well-known/oauth-protected-resource")
let media_token = ("POST", "/api/tokens/media")
let representation = ("GET", "/resources/{id}")
let graph = ("GET", "/resources/{id}/jsonld")
let annotations = ("GET", "/resources/{id}/annotations")
let anchored_text = ("GET", "/resources/{id}/anchored-text")
let upload = ("POST", "/resources")
let status_code = function
  | 401 -> "unauthorized"
  | 403 -> "forbidden"
  | 404 -> "not-found"
  | 409 -> "conflict"
  | 400 -> "bad-request"
  | 422 -> "unprocessable"
  | 429 -> "rate-limited"
  | status when status >= 500 -> "unavailable"
  | _ -> "error"
module Failure_code = struct
  type t = Not_found | Peer_unavailable | Unauthorized | None_pending
  let of_wire = function
    | "not-found" -> Not_found
    | "peer-unavailable" -> Peer_unavailable
    | "unauthorized" -> Unauthorized
    | "none-pending" -> None_pending
    | code -> invalid_arg ("a failure's code \"" ^ code ^ "\" is none of CommandError's: the reader leaves such a code out")
end
let bus_failure = function
  | None -> "bus.rejected"
  | Some Failure_code.Not_found -> "bus.not-found"
  | Some Failure_code.Peer_unavailable -> "bus.peer-unavailable"
  | Some Failure_code.Unauthorized -> "bus.unauthorized"
  | Some Failure_code.None_pending -> "bus.none-pending"
let retry_statuses = [408; 413; 429; 500; 502; 503]
let upload_fields = ["name"; "file"; "format"; "storageUri"; "language"; "entityTypes"; "sourceAnnotationId"; "sourceResourceId"; "generationPrompt"; "generator"; "jobId"; "isDraft"; "cloneToken"; "archiveOriginal"]
