type proof = Secret of string | Key of Oauth.rsa_key
type failure = { error : Oauth.error; status : int option }

let request http run =
  let status = ref None in
  let call input =
    let code, body = http input in
    status := Some code;
    (code, body)
  in
  try Result.map_error (fun error -> { error; status = !status }) (run call)
  with Eio.Io _ | End_of_file ->
    Error { error = Oauth.Invalid_response; status = None }

type service_token = {
  clock : Clock.t;
  http : Oauth.http;
  authority : string;
  client_id : string;
  proof : proof;
  jti : unit -> string;
  lock : Eio.Mutex.t;
  mutable issuer : Oauth.issuer option;
  mutable cached : (string * Mtime.t) option;
  mutable closed : bool;
}

let make ~clock ~http ~authority ~client_id ~proof ~jti () =
  {
    clock;
    http;
    authority;
    client_id;
    proof;
    jti;
    lock = Eio.Mutex.create ();
    issuer = None;
    cached = None;
    closed = false;
  }

let grant ~clock ~http ~issuer ~client_id ~proof ~jti =
  match proof with
  | Secret client_secret ->
      Oauth.service_secret http issuer ~client_id ~client_secret
  | Key key -> Oauth.service_key http issuer ~clock ~jti ~client_id ~key

let acquire t refused =
  Eio.Mutex.use_rw ~protect:false t.lock (fun () ->
      let now = Clock.monotonic_now t.clock in
      match t.cached with
      | _ when t.closed ->
          Error
            {
              error = Oauth.Rejected { code = "session.closed"; status = None };
              status = None;
            }
      | Some (token, due)
        when Mtime.compare now due < 0 && Some token <> refused ->
          Ok token
      | _ ->
          t.cached <- None;
          let ( let* ) = Result.bind in
          let* issuer =
            match t.issuer with
            | Some issuer -> Ok issuer
            | None ->
                Result.map
                  (fun issuer ->
                    t.issuer <- Some issuer;
                    issuer)
                  (request t.http (fun http ->
                       Oauth.discover http ~issuer:t.authority))
          in
          let* tokens =
            request t.http (fun http ->
                grant ~clock:t.clock ~http ~issuer ~client_id:t.client_id
                  ~proof:t.proof ~jti:t.jti)
          in
          let instant = Clock.monotonic_now t.clock in
          t.cached <-
            Option.bind tokens.expires_in (fun lifetime ->
                let lifetime = float lifetime in
                let reuse =
                  min lifetime
                    (Tokens.renewal_delay ~lifetime ~remaining:lifetime)
                in
                let nanos =
                  Int64.of_float (min 9.22e18 (ceil (reuse *. 1e9)))
                in
                Option.map
                  (fun due -> (tokens.access_token, due))
                  (Mtime.add_span instant (Mtime.Span.of_uint64_ns nanos)));
          Ok tokens.access_token)

let token t = acquire t None
let renew t ~refused = acquire t (Some refused)
let authorization t = Result.map (fun token -> "Bearer " ^ token) (token t)

let dispose t =
  Eio.Mutex.use_rw ~protect:false t.lock (fun () ->
      t.closed <- true;
      t.cached <- None)
