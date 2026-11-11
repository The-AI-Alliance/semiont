include Namespace_methods.Job
module B = Bus_registry

let queued client receive =
  Client_core.on_channel client B.Channels.job_queued receive

let progress client receive =
  Client_core.on_channel client B.Channels.job_report_progress receive

let complete client receive =
  Client_core.on_channel client B.Channels.job_complete receive

let fail client receive =
  Client_core.on_channel client B.Channels.job_fail receive

let poll_until_complete client ?(every_ms = Client_timing.job_poll_ms)
    ?(within_ms = Client_timing.job_poll_timeout_ms) ~on_status payload =
  let clock = Client_core.clock client in
  let after stamp milliseconds =
    Mtime.add_span stamp Mtime.Span.(max 0 milliseconds * ms)
    |> Option.value ~default:Mtime.max_stamp
  in
  let deadline = after (Clock.monotonic_now clock) within_ms in
  let timeout = Error (Client_core.Transport Subscription.Timeout) in
  let rec poll () =
    if Mtime.compare (Clock.monotonic_now clock) deadline >= 0 then timeout
    else
      match status client payload with
      | Error _ as error -> error
      | Ok reply -> (
          on_status reply;
          let open Yojson.Safe.Util in
          match
            Yojson.Safe.from_string (B.encode reply)
            |> member "response" |> member "status"
          with
          | `String ("complete" | "failed" | "cancelled") -> Ok reply
          | _ ->
              Clock.sleep_until clock
                (after (Clock.monotonic_now clock) (max 1 every_ms));
              poll ())
  in
  Eio.Fiber.first poll (fun () ->
      Clock.sleep_until clock deadline;
      timeout)

let claim = Claims.make
