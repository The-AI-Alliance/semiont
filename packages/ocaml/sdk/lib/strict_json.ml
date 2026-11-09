exception Invalid_json of int

let utf8 text =
  Uutf.String.fold_utf_8
    (fun valid _ -> function `Uchar _ -> valid | `Malformed _ -> false)
    true text

let parse source =
  let length = String.length source in
  let fail index = raise (Invalid_json index) in
  let at index = if index < length then source.[index] else '\000' in
  let digit index = match at index with '0' .. '9' -> true | _ -> false in
  let rec digits index =
    if index < length && digit index then digits (index + 1) else index
  in
  let rec space index =
    match at index with
    | ' ' | '\t' | '\r' | '\n' -> space (index + 1)
    | _ -> index
  in
  let number index =
    let first = if at index = '-' then index + 1 else index in
    let integer =
      match at first with
      | '0' -> first + 1
      | '1' .. '9' -> digits (first + 1)
      | _ -> fail first
    in
    let fraction =
      if at integer <> '.' then integer
      else if digit (integer + 1) then digits (integer + 2)
      else fail (integer + 1)
    in
    match at fraction with
    | 'e' | 'E' ->
        let exponent =
          match at (fraction + 1) with
          | '+' | '-' -> fraction + 2
          | _ -> fraction + 1
        in
        if digit exponent then digits (exponent + 1) else fail exponent
    | _ -> fraction
  in
  let string first =
    let rec scan index =
      if index >= length then fail index;
      match source.[index] with
      | '"' ->
          let last = index + 1 in
          let literal = String.sub source first (last - first) in
          let decoded =
            match Yojson.Safe.from_string literal with
            | `String text -> text
            | _ -> fail first
          in
          if not (utf8 decoded) then fail first;
          last
      | '\\' -> (
          match at (index + 1) with
          | '"' | '\\' | '/' | 'b' | 'f' | 'n' | 'r' | 't' -> scan (index + 2)
          | 'u' ->
              for at_ = index + 2 to index + 5 do
                match at at_ with
                | '0' .. '9' | 'a' .. 'f' | 'A' .. 'F' -> ()
                | _ -> fail at_
              done;
              scan (index + 6)
          | _ -> fail (index + 1))
      | '\000' .. '\031' -> fail index
      | _ -> scan (index + 1)
    in
    scan (first + 1)
  in
  let literal index text =
    let size = String.length text in
    if index + size > length || String.sub source index size <> text then
      fail index;
    index + size
  in
  let rec value index =
    let index = space index in
    match at index with
    | '"' -> string index
    | '{' ->
        let next = space (index + 1) in
        if at next = '}' then next + 1 else members next
    | '[' ->
        let next = space (index + 1) in
        if at next = ']' then next + 1 else elements next
    | 't' -> literal index "true"
    | 'f' -> literal index "false"
    | 'n' -> literal index "null"
    | '-' | '0' .. '9' -> number index
    | _ -> fail index
  and members index =
    if at index <> '"' then fail index;
    let colon = space (string index) in
    if at colon <> ':' then fail colon;
    let next = space (value (colon + 1)) in
    match at next with
    | '}' -> next + 1
    | ',' -> members (space (next + 1))
    | _ -> fail next
  and elements index =
    let next = space (value index) in
    match at next with
    | ']' -> next + 1
    | ',' -> elements (space (next + 1))
    | _ -> fail next
  in
  try
    if not (utf8 source) then fail 0;
    let last = space (value 0) in
    if last <> length then fail last;
    Ok (Yojson.Raw.from_string source)
  with
  | Invalid_json index -> Error (Printf.sprintf "Invalid JSON at byte %d" index)
  | Yojson.Json_error message -> Error message
