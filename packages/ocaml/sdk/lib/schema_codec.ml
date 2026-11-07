open Schema_shape

type fault = { member : string; reason : [ `Lacks | `Malformed ] }
type error = Invalid_json of string | Invalid_payload of fault

let ( let* ) = Result.bind
let malformed member = Error { member; reason = `Malformed }
let lacks member = Error { member; reason = `Lacks }
let child path key = if path = "" then key else path ^ "." ^ key
let shapes = List.to_seq Schema_shapes.all |> Hashtbl.of_seq

let rec resolve shape =
  match shape.reference with
  | None -> shape
  | Some name -> resolve (Hashtbl.find shapes name)

(* A coefficient and decimal exponent keep comparison exact without expanding
   a literal such as 1e1000000000 into a billion digits. *)
let number literal =
  let sign, unsigned =
    if literal.[0] = '-' then
      (-1, String.sub literal 1 (String.length literal - 1))
    else (1, literal)
  in
  let mantissa, exponent =
    match String.split_on_char 'e' (String.lowercase_ascii unsigned) with
    | [ mantissa; exponent ] -> (mantissa, Z.of_string exponent)
    | [ mantissa ] -> (mantissa, Z.zero)
    | _ -> assert false
  in
  let digits, fraction =
    match String.split_on_char '.' mantissa with
    | [ whole; fraction ] -> (whole ^ fraction, String.length fraction)
    | [ whole ] -> (whole, 0)
    | _ -> assert false
  in
  let length = String.length digits in
  let rec first at =
    if at < length && digits.[at] = '0' then first (at + 1) else at
  in
  let rec last at = if digits.[at] = '0' then last (at - 1) else at in
  let start = first 0 in
  if start = length then (0, "", Z.zero)
  else
    let stop = last (length - 1) in
    let scale = Z.add exponent (Z.of_int (length - 1 - stop - fraction)) in
    (sign, String.sub digits start (stop - start + 1), scale)

let compare_number (left_sign, left, left_scale) (right_sign, right, right_scale)
    =
  let order = Int.compare left_sign right_sign in
  if order <> 0 then order
  else
    let magnitude digits scale =
      Z.add scale (Z.of_int (String.length digits))
    in
    let order =
      Z.compare (magnitude left left_scale) (magnitude right right_scale)
    in
    left_sign * if order = 0 then String.compare left right else order

let text literal =
  match Yojson.Safe.from_string literal with
  | `String value -> value
  | _ -> assert false

let allows kind = function None -> true | Some kinds -> List.mem kind kinds

let allows_value shape value =
  let kinds = (resolve shape).kinds in
  match value with
  | `Assoc _ -> allows Object kinds
  | `List _ -> allows Array kinds
  | `Stringlit _ -> allows String kinds
  | `Intlit _ -> allows Integer kinds || allows Number kinds
  | `Floatlit literal ->
      allows Number kinds
      || allows Integer kinds
         &&
         let _, _, scale = number literal in
         Z.sign scale >= 0
  | `Bool _ -> allows Boolean kinds
  | `Null -> allows Null kinds

let equal_scalar left right =
  match (left, right) with
  | `Stringlit left, `Stringlit right -> String.equal (text left) (text right)
  | (`Intlit left | `Floatlit left), (`Intlit right | `Floatlit right) ->
      compare_number (number left) (number right) = 0
  | _ -> left = right

let check path condition = if condition then Ok () else malformed path

let within compare lower upper value =
  Option.fold ~none:true ~some:(fun bound -> compare value bound >= 0) lower
  && Option.fold ~none:true ~some:(fun bound -> compare value bound <= 0) upper

let rec each visit = function
  | [] -> Ok ()
  | item :: rest ->
      let* () = visit item in
      each visit rest

let rec validate path shape value =
  let shape = resolve shape in
  let* () = check path (allows_value shape value) in
  let* () =
    check path
      (Option.fold ~none:true
         ~some:(List.exists (equal_scalar value))
         shape.enum)
  in
  let* () = validate_kind path shape value in
  let* () = validate_variants path shape value in
  each (fun part -> validate path part value) shape.all_of

and validate_kind path shape = function
  | `Assoc fields -> validate_object path shape fields
  | `List values ->
      let* () =
        check path
          (within Int.compare shape.min_items shape.max_items
             (List.length values))
      in
      Option.fold ~none:(Ok ())
        ~some:(fun item -> each (validate path item) values)
        shape.items
  | `Stringlit literal ->
      let value = text literal in
      let length =
        Uutf.String.fold_utf_8 (fun count _ _ -> count + 1) 0 value
      in
      check path
        (within Int.compare shape.min_length shape.max_length length
        && Option.fold ~none:true
             ~some:(fun steps -> Pattern.matches steps value)
             shape.pattern)
  | `Intlit value | `Floatlit value ->
      if shape.minimum = None && shape.maximum = None then Ok ()
      else
        let numeric = number value in
        check path
          (within
             (fun numeric bound -> compare_number numeric (number bound))
             shape.minimum shape.maximum numeric)
  | `Bool _ | `Null -> Ok ()

and validate_object path shape fields =
  let member key = List.assoc_opt key shape.members in
  let sorted =
    List.sort (fun (left, _) (right, _) -> String.compare left right) fields
  in
  let* () =
    each
      (fun key ->
        match List.assoc_opt key fields with
        | None -> lacks (child path key)
        | Some `Null ->
            if
              Option.fold ~none:true
                ~some:(fun shape -> allows_value shape `Null)
                (member key)
            then Ok ()
            else lacks (child path key)
        | Some _ -> Ok ())
      shape.required
  in
  let* () =
    each
      (fun (key, shape) ->
        match List.assoc_opt key fields with
        | None | Some `Null -> Ok ()
        | Some value -> validate (child path key) shape value)
      shape.members
  in
  let* () =
    Option.fold ~none:(Ok ())
      ~some:(fun names ->
        each
          (fun (key, _) -> check (child path key) (List.mem key names))
          sorted)
      shape.closed
  in
  Option.fold ~none:(Ok ())
    ~some:(fun shape ->
      each (fun (_, value) -> validate path shape value) sorted)
    shape.values

and validate_variants path shape value =
  match shape.variants with
  | [] -> Ok ()
  | variants -> (
      let selected =
        match (shape.discriminator, value) with
        | Some (key, mapping), `Assoc fields -> (
            match List.assoc_opt key fields with
            | Some (`Stringlit literal) ->
                Option.map (List.nth variants)
                  (List.assoc_opt (text literal) mapping)
            | _ -> None)
        | _ -> None
      in
      match selected with
      | Some variant -> validate path variant value
      | None -> (
          let candidates =
            List.filter (fun shape -> allows_value shape value) variants
          in
          let rec try_rest first = function
            | [] -> first
            | variant :: rest -> (
                match validate path variant value with
                | Ok () -> Ok ()
                | Error _ -> try_rest first rest)
          in
          match candidates with
          | [] -> malformed path
          | first :: rest -> (
              match validate path first value with
              | Ok () -> Ok ()
              | Error _ as fault -> try_rest fault rest)))

let decode shape source =
  match Strict_json.parse source with
  | Error message -> Error (Invalid_json message)
  | Ok value -> (
      match validate "" shape value with
      | Ok () -> Ok value
      | Error fault -> Error (Invalid_payload fault))
