type t

val make : Client.t -> locale:string -> t
val is_generating : t -> bool State_value.t
val progress : t -> Yojson.Safe.t option State_value.t
val outcome : t -> Yojson.Safe.t option State_value.t
val failure : t -> Delegation.failure option State_value.t
val job_id : t -> string option State_value.t
val generate : t -> ?stall_ms:int -> [ `GenerationJobRequest ] Models.t -> unit
val dismiss_progress : t -> unit
val dispose : t -> unit
