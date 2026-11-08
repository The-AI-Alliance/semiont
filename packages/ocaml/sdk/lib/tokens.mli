(** Unverified JWT claims for scheduling and display. Times are in seconds. *)

val text_claim : string -> string -> string option
val token_expiry : string -> float option
val is_token_expired : now:float -> string -> bool
val renewal_delay : lifetime:float -> remaining:float -> float
val refresh_delay : now:float -> string -> float option
