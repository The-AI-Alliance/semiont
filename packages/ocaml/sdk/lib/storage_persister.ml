type storage_persister = {
  storage : Storage.t;
  key : string;
  version : int;
  max_bytes : int;
  clock : Clock.t;
}

type entry = { key : Live_query.key; value : Yojson.Safe.t; written : float }
type document = { entries : entry list; positions : (string * string) list }

let empty = { entries = []; positions = [] }

let make ~storage ~key ~version ~max_bytes ~clock =
  if max_bytes < 0 then invalid_arg "negative cache byte cap";
  { storage; key; version; max_bytes; clock }

let key_json (name, scope, argument) =
  let text = function None -> `Null | Some value -> `String value in
  `List [ `String name; text scope; text argument ]

let key_of_json =
  let optional = Yojson.Safe.Util.to_string_option in
  function
  | `List [ `String name; scope; argument ] ->
      (name, optional scope, optional argument)
  | _ -> invalid_arg "invalid cache key"

let decode t = function
  | None -> empty
  | Some source -> (
      let open Yojson.Safe.Util in
      try
        (match Strict_json.parse source with
        | Error _ -> invalid_arg "invalid cache JSON"
        | Ok _ -> ());
        let value = Yojson.Safe.from_string source in
        if to_int (member "version" value) <> t.version then empty
        else if not (Float.is_finite (to_number (member "writtenAt" value)))
        then empty
        else
          let entries =
            to_list (member "entries" value)
            |> List.map (function
              | `List [ key; value; timestamp ] ->
                  let written = to_number timestamp in
                  if not (Float.is_finite written) then
                    invalid_arg "invalid cache timestamp";
                  { key = key_of_json key; value; written }
              | _ -> invalid_arg "invalid cache entry")
          in
          let positions =
            match member "positions" value with
            | `Null -> []
            | values ->
                List.map
                  (fun (key, value) -> (key, to_string value))
                  (to_assoc values)
          in
          if
            List.length entries
            <> List.length
                 (List.sort_uniq compare
                    (List.map (fun entry -> entry.key) entries))
          then empty
          else { entries; positions }
      with Yojson.Json_error _ | Type_error _ | Invalid_argument _ -> empty)

let document t = decode t (Storage.get t.storage t.key)

let restore t key =
  List.find_map
    (fun entry -> if entry.key = key then Some entry.value else None)
    (document t).entries

let positions t = (document t).positions

let save_document t ~covered_only ?positions changes =
  let now = Clock.wall_now t.clock *. 1000. in
  Storage.update t.storage t.key (fun source ->
      let prior = decode t source in
      let update entries (key, value) =
        let previous = List.find_opt (fun entry -> entry.key = key) entries in
        let rest = List.filter (fun entry -> entry.key <> key) entries in
        match value with
        | None -> rest
        | Some value ->
            let written =
              match previous with
              | Some entry when entry.value = value -> entry.written
              | _ -> now
            in
            { key; value; written } :: rest
      in
      let entries = List.fold_left update prior.entries changes in
      let positions =
        match positions with
        | None -> prior.positions
        | Some positions when not covered_only -> positions
        | Some positions ->
            List.fold_left
              (fun merged (scope, id) ->
                let covered entry =
                  let _, resource, _ = entry.key in
                  resource <> Some scope || List.mem_assoc entry.key changes
                in
                if List.for_all covered prior.entries then
                  (scope, id) :: List.remove_assoc scope merged
                else merged)
              prior.positions positions
      in
      let encode entries positions =
        Yojson.Safe.to_string
          (`Assoc
             [
               ("version", `Int t.version);
               ("writtenAt", `Float now);
               ( "entries",
                 `List
                   (List.map
                      (fun entry ->
                        `List
                          [
                            key_json entry.key;
                            entry.value;
                            `Float entry.written;
                          ])
                      entries) );
               ( "positions",
                 `Assoc
                   (List.map
                      (fun (key, value) -> (key, `String value))
                      positions) );
             ])
      in
      let rec fit entries positions =
        let encoded = encode entries positions in
        if String.length encoded <= t.max_bytes then Some encoded
        else
          match (entries, positions) with
          | _ :: remaining, _ -> fit remaining []
          | [], _ :: _ -> fit [] []
          | [], [] -> None
      in
      let ordered =
        List.sort
          (fun a b -> compare (a.written, a.key) (b.written, b.key))
          entries
      in
      fit ordered positions)

let save_batch t ?positions changes =
  save_document t ~covered_only:false ?positions changes

let save_covered t ~positions changes =
  save_document t ~covered_only:true ~positions changes

let save t key value = save_batch t [ (key, value) ]
