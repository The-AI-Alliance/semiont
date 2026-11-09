let knowledge_base_did domain = "did:web:" ^ domain

let resource domain =
  "https://" ^ String.map (function ':' -> '/' | char -> char) domain

type kind = Person | Agent

let principal ~domain ~kind subject =
  let encoded = Buffer.create (String.length subject) in
  String.iter
    (function
      | ( 'A' .. 'Z'
        | 'a' .. 'z'
        | '0' .. '9'
        | '-' | '_' | '.' | '!' | '~' | '*' | '\'' | '(' | ')' ) as char ->
          Buffer.add_char encoded char
      | char -> Printf.bprintf encoded "%%%02X" (Char.code char))
    subject;
  let segment = match kind with Person -> ":users:" | Agent -> ":agents:" in
  knowledge_base_did domain ^ segment ^ Buffer.contents encoded
