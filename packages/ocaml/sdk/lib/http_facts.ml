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
let bus_failure = function
  | Some "not-found" -> "bus.not-found"
  | Some "peer-unavailable" -> "bus.peer-unavailable"
  | Some "unauthorized" -> "bus.unauthorized"
  | Some "none-pending" -> "bus.none-pending"
  | _ -> "bus.rejected"
let retry_statuses = [408; 413; 429; 500; 502; 503]
let upload_fields = ["name"; "file"; "format"; "storageUri"; "language"; "entityTypes"; "sourceAnnotationId"; "sourceResourceId"; "generationPrompt"; "generator"; "jobId"; "isDraft"; "cloneToken"; "archiveOriginal"]
