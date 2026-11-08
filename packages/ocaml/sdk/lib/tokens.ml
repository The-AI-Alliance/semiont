let claims token =
  match String.split_on_char '.' token with
  | [ _; payload; _ ] -> (
      match
        Base64.decode ~pad:false ~alphabet:Base64.uri_safe_alphabet payload
      with
      | Ok source -> (
          match Strict_json.parse source with
          | Ok (`Assoc fields) -> fields
          | _ -> [])
      | Error _ -> [])
  | _ -> []

let filter predicate = function
  | Some value when predicate value -> Some value
  | _ -> None

let timestamp name fields =
  match List.assoc_opt name fields with
  | Some (`Intlit literal | `Floatlit literal) ->
      filter Float.is_finite (float_of_string_opt literal)
  | _ -> None

let token_expiry token = timestamp "exp" (claims token)

let text_claim token name =
  match List.assoc_opt name (claims token) with
  | Some (`Stringlit value) -> (
      match Yojson.Safe.from_string value with
      | `String decoded -> Some decoded
      | _ -> None)
  | _ -> None

let is_token_expired ~now token =
  match token_expiry token with None -> true | Some expiry -> expiry <= now

let renewal_delay ~lifetime ~remaining =
  let seconds ms = float ms /. 1000. in
  let margin =
    min (seconds Client_timing.refresh_before_exp_ms) (max 0. (lifetime /. 2.))
  in
  max (seconds Client_timing.min_refresh_delay_ms) (remaining -. margin)

let refresh_delay ~now token =
  let fields = claims token in
  Option.map
    (fun expiry ->
      let issued = Option.value (timestamp "iat" fields) ~default:now in
      renewal_delay ~lifetime:(expiry -. issued) ~remaining:(expiry -. now))
    (timestamp "exp" fields)
