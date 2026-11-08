let rec shown = function
  | `Assoc fields ->
      `Assoc
        (List.map
           (fun (key, value) ->
             ( key,
               if List.mem key Log_facts.credentials then `String "[withheld]"
               else shown value ))
           fields)
  | `List values -> `List (List.map shown values)
  | value -> value

let enabled =
  lazy
    (match Sys.getenv_opt "SEMIONT_BUS_LOG" with
    | Some value -> value <> ""
    | None -> false)

let active () = Lazy.force enabled
let short value = String.sub value 0 (min (String.length value) 8)

let trace_id parent =
  match String.split_on_char '-' parent with
  | _ :: id :: _ when String.length id = 32 -> Some id
  | _ -> None

let line op ~channel ?scope ?correlation_id ?trace payload =
  let field key value =
    Option.fold ~none:"" ~some:(fun value -> " " ^ key ^ "=" ^ value) value
  in
  Printf.sprintf "[bus %s] %s%s%s%s %s" op channel (field "scope" scope)
    (field "cid" (Option.map short correlation_id))
    (field "trace" (Option.map short trace))
    (Yojson.Safe.to_string (shown payload))

let write op ~channel ?scope ?correlation_id ?trace payload =
  if active () then
    Printf.printf "%s\n%!"
      (line op ~channel ?scope ?correlation_id ?trace payload)
