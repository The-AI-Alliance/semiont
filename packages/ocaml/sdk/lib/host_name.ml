let is_valid_hostname host =
  let alphanumeric = function
    | 'a' .. 'z' | 'A' .. 'Z' | '0' .. '9' -> true
    | _ -> false
  in
  let valid label =
    let size = String.length label in
    size > 0 && size <= 63
    && alphanumeric label.[0]
    && alphanumeric label.[size - 1]
    && String.for_all (fun char -> char = '-' || alphanumeric char) label
  in
  List.for_all valid (String.split_on_char '.' host)

let gateway_url endpoint =
  let endpoint = Records.Http_endpoint.of_model endpoint in
  if is_valid_hostname endpoint.host then
    Some
      (Printf.sprintf "%s://%s:%s" endpoint.protocol
         (String.lowercase_ascii endpoint.host)
         (Yojson.Raw.to_string endpoint.port))
  else None
