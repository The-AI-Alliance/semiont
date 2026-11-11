open Schema_shape

type fault = { member : string; reason : [ `Lacks | `Malformed ] }
type error = Invalid_json of string | Invalid_payload of fault

let ( let* ) = Result.bind
let malformed member = Error { member; reason = `Malformed }
let lacks member = Error { member; reason = `Lacks }
let child path key = if path = "" then key else path ^ "." ^ key

let shapes =
  List.to_seq Schema_shapes.all
  |> Seq.map (fun (name, shape) -> (name, shape ()))
  |> Hashtbl.of_seq

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

let rec read_each visit = function
  | [] -> Ok []
  | item :: rest ->
      let* read = visit item in
      let* reads = read_each visit rest in
      Ok (read :: reads)

(* A member whose shape recognizes texts, holding a text none of them: a reader
   reads it as absent, and a writer holds it to them as to an enum. *)
type direction = Reading | Writing

let recognizes codes = function
  | `Stringlit literal -> List.mem (text literal) codes
  | _ -> false

let unrecognized shape value =
  match ((resolve shape).recognized, value) with
  | Some codes, `Stringlit _ -> not (recognizes codes value)
  | _ -> false

let reread fields reads =
  List.map
    (fun (key, value) ->
      match List.assoc_opt key reads with
      | Some read -> (key, read)
      | None -> (key, value))
    fields

let by_name fields =
  List.sort (fun (left, _) (right, _) -> String.compare left right) fields

let rec validate direction path shape value =
  let shape = resolve shape in
  let* () = check path (allows_value shape value) in
  let* () =
    check path
      (Option.fold ~none:true
         ~some:(List.exists (equal_scalar value))
         shape.enum)
  in
  let* () =
    check path
      (Option.fold ~none:true
         ~some:(fun codes -> recognizes codes value)
         shape.recognized)
  in
  let* value = validate_kind direction path shape value in
  let* value = validate_variants direction path shape value in
  validate_all direction path shape.all_of value

and validate_all direction path parts value =
  match parts with
  | [] -> Ok value
  | part :: rest ->
      let* value = validate direction path part value in
      validate_all direction path rest value

and validate_kind direction path shape = function
  | `Assoc fields ->
      let* fields = validate_object direction path shape fields in
      Ok (`Assoc fields)
  | `List values -> (
      let* () =
        check path
          (within Int.compare shape.min_items shape.max_items
             (List.length values))
      in
      match shape.items with
      | None -> Ok (`List values)
      | Some item ->
          let* values = read_each (validate direction path item) values in
          Ok (`List values))
  | `Stringlit literal as value ->
      let content = text literal in
      let length =
        Uutf.String.fold_utf_8 (fun count _ _ -> count + 1) 0 content
      in
      let* () =
        check path
          (within Int.compare shape.min_length shape.max_length length
          && Option.fold ~none:true
               ~some:(fun steps -> Pattern.matches steps content)
               shape.pattern)
      in
      Ok value
  | (`Intlit literal | `Floatlit literal) as value ->
      let* () =
        if shape.minimum = None && shape.maximum = None then Ok ()
        else
          check path
            (within
               (fun numeric bound -> compare_number numeric (number bound))
               shape.minimum shape.maximum (number literal))
      in
      Ok value
  | (`Bool _ | `Null) as value -> Ok value

and validate_object direction path shape fields =
  let member key = List.assoc_opt key shape.members in
  let fields =
    match direction with
    | Writing -> fields
    | Reading ->
        List.filter
          (fun (key, value) ->
            match member key with
            | Some shape -> not (unrecognized shape value)
            | None -> true)
          fields
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
  let* members =
    read_each
      (fun (key, shape) ->
        match List.assoc_opt key fields with
        | None | Some `Null -> Ok []
        | Some value ->
            let* read = validate direction (child path key) shape value in
            Ok [ (key, read) ])
      shape.members
  in
  let fields = reread fields (List.concat members) in
  let* () =
    Option.fold ~none:(Ok ())
      ~some:(fun names ->
        each
          (fun (key, _) -> check (child path key) (List.mem key names))
          (by_name fields))
      shape.closed
  in
  match shape.values with
  | None -> Ok fields
  | Some shape ->
      let* values =
        read_each
          (fun (key, value) ->
            let* read = validate direction path shape value in
            Ok (key, read))
          (by_name fields)
      in
      Ok (reread fields values)

and validate_variants direction path shape value =
  match shape.variants with
  | [] -> Ok value
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
      | Some variant -> validate direction path variant value
      | None -> (
          let candidates =
            List.filter (fun shape -> allows_value shape value) variants
          in
          let rec try_rest first = function
            | [] -> first
            | variant :: rest -> (
                match validate direction path variant value with
                | Ok _ as read -> read
                | Error _ -> try_rest first rest)
          in
          match candidates with
          | [] -> malformed path
          | first :: rest -> (
              match validate direction path first value with
              | Ok _ as read -> read
              | Error _ as fault -> try_rest fault rest)))

let decode shape source =
  match Strict_json.parse source with
  | Error message -> Error (Invalid_json message)
  | Ok value -> (
      match validate Writing "" shape value with
      | Ok value -> Ok value
      | Error fault -> Error (Invalid_payload fault))

(* The HTTP gateway stamps these verified identity facts after it validates
   the channel payload. Keep them for consumers, beside the payload as read. *)
let decode_received shape source =
  match Strict_json.parse source with
  | Error message -> Error (Invalid_json message)
  | Ok (`Assoc fields) -> (
      let auth = function "_userId" | "_roles" -> true | _ -> false in
      let identity, payload =
        List.partition (fun (key, _) -> auth key) fields
      in
      let identity_shape =
        object_
          ~members:
            [
              ("_userId", reference "UserId");
              ( "_roles",
                {
                  any with
                  kinds = Some [ Array ];
                  items = Some { any with kinds = Some [ String ] };
                } );
            ]
          ()
      in
      let result =
        let* read = validate Reading "" shape (`Assoc payload) in
        let* _ = validate Reading "" identity_shape (`Assoc identity) in
        Ok read
      in
      match result with
      | Ok (`Assoc read) -> Ok (`Assoc (read @ identity))
      | Ok _ -> assert false (* an object reads as an object *)
      | Error fault -> Error (Invalid_payload fault))
  | Ok value -> (
      match validate Reading "" shape value with
      | Ok value -> Ok value
      | Error fault -> Error (Invalid_payload fault))
