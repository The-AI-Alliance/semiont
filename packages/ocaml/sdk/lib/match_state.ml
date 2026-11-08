open Eio.Std
module B = Bus_registry

type t = {
  closed : unit Promise.t;
  close : unit Promise.u;
  release : Client.unsubscribe;
}

let make client =
  let closed, close = Promise.create () in
  let request = B.Channels.match_search_requested in
  let operation = B.Operations.match_search_requested in
  let listener = function
    | Ok (Wire_stream.Frame { route; payload = Ok payload; _ })
      when route.channel = B.name request ->
        let raw = B.encode payload in
        let correlation_id = route.correlation_id in
        let rejected code =
          let reference =
            Yojson.Safe.from_string raw |> Yojson.Safe.Util.member "referenceId"
          in
          let body =
            Yojson.Safe.to_string
              (`Assoc [ ("referenceId", reference); ("error", `String code) ])
          in
          match B.decode B.Channels.match_search_failed body with
          | Ok payload ->
              Client.publish client ?correlation_id
                B.Channels.match_search_failed payload
          | Error _ -> ()
        in
        Fiber.fork_daemon ~sw:(Client.switch client) (fun () ->
            Fiber.first
              (fun () ->
                try
                  match Client.request client operation raw with
                  | Ok (Subscription.Result payload) ->
                      Client.publish client ?correlation_id
                        B.Channels.match_search_results payload
                  | Ok (Subscription.Failure payload) ->
                      Client.publish client ?correlation_id
                        B.Channels.match_search_failed payload
                  | Error Subscription.Timeout -> rejected "bus.timeout"
                  | Error _ -> rejected "bus.closed"
                with Http_wire.Failed failure -> rejected failure.code)
              (fun () -> Promise.await closed);
            `Stop_daemon)
    | _ -> ()
  in
  let release = Client.on_frame client listener in
  { closed; close; release }

let dispose t =
  if not (Promise.is_resolved t.closed) then (
    Promise.resolve t.close ();
    t.release ())
