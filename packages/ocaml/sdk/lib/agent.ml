type proof = Service_token.proof = Secret of string | Key of Oauth.rsa_key

type error =
  | Issuer of Oauth.error
  | Gateway of Http_wire.failure
  | Invalid_identity

type t = { did : Identifiers.User_id.t; session : Session.t }

let did t = t.did
let session t = t.session
let close t = Session.close t.session

let sign_in ~sw ~clock ~issuer ~http ~client_id ~proof ~key ~call () =
  let grant () =
    Service_token.grant ~clock ~http ~issuer ~client_id ~proof ~jti:key
  in
  match grant () with
  | Error error -> Error (Issuer error)
  | Ok initial ->
      let renew ~refused:_ =
        match grant () with
        | Ok tokens -> Session.Renewed tokens.access_token
        | Error _ -> Session.Unavailable
      in
      let session =
        Session.start ~keep_on_unavailable:true ~sw ~clock
          ~initial_token:(Some initial.access_token) ~renew ()
      in
      let http =
        Http_wire.make ~clock ~session ~key ~on_error:ignore ~call ()
      in
      let identify () =
        try
          let body = Http_wire.current_user http in
          match Models.decode Models.user_response body with
          | Error _ -> Error Invalid_identity
          | Ok user -> (
              match (Records.User_response.of_model user).did with
              | `Stringlit value -> (
                  match
                    Identifiers.User_id.of_string
                      (Yojson.Safe.from_string value
                      |> Yojson.Safe.Util.to_string)
                  with
                  | Ok did -> Ok { did; session }
                  | Error _ -> Error Invalid_identity)
              | _ -> Error Invalid_identity)
        with Http_wire.Failed error -> Error (Gateway error)
      in
      let success = ref false in
      Fun.protect
        ~finally:(fun () -> if not !success then Session.close session)
        (fun () ->
          let result = identify () in
          success := Result.is_ok result;
          result)
