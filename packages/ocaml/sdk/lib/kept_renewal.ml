(* protocol/specs/src/sign-in-store/README.md, Renewing it, rule 1: a kept
   access token that is not the one handed and has not expired was renewed by
   another writer, and is given without a grant. *)
let renewed_elsewhere ~now ~holding ~expiry access =
  Some access <> holding && Option.exists (fun expiry -> expiry > now) expiry
