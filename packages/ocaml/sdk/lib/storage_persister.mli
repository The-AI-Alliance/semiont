type storage_persister

val make :
  storage:Storage.t ->
  key:string ->
  version:int ->
  max_bytes:int ->
  clock:Clock.t ->
  storage_persister

val restore : storage_persister -> Live_query.key -> Yojson.Safe.t option
val positions : storage_persister -> (string * string) list

val save_batch :
  storage_persister ->
  ?positions:(string * string) list ->
  (Live_query.key * Yojson.Safe.t option) list ->
  unit
(** Commit changes and their corresponding replay positions in one atomic
    update. Only supply positions covered by the saved snapshot. *)

val save : storage_persister -> Live_query.key -> Yojson.Safe.t option -> unit

val save_covered :
  storage_persister ->
  positions:(string * string) list ->
  (Live_query.key * Yojson.Safe.t option) list ->
  unit
(** Retains the previous position of any scope with a persisted key outside the
    batch. *)
