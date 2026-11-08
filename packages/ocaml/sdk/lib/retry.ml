type rule = Boot | Job | Transport | Refresh
type budget = { attempts : int; initial_delay_ms : int; max_delay_ms : int }

let retryable rule ?status ?meth ?(keyed = false) () =
  let has statuses =
    Option.fold ~none:false
      ~some:(fun status -> List.mem status statuses)
      status
  in
  let job status = status = 408 || status = 429 || status >= 500 in
  match rule with
  | Boot -> has [ 429; 503; 504 ]
  | Job -> Option.fold ~none:false ~some:job status
  | Refresh -> Option.fold ~none:true ~some:job status
  | Transport ->
      has [ 408; 413; 429; 500; 502; 503; 504 ]
      && (keyed
         || Option.fold ~none:false
              ~some:(fun meth ->
                List.mem
                  (String.uppercase_ascii meth)
                  [ "GET"; "HEAD"; "PUT"; "DELETE"; "OPTIONS"; "TRACE" ])
              meth)

let retry_after_ms header =
  let digits = String.trim header in
  if
    digits = ""
    || not (String.for_all (function '0' .. '9' -> true | _ -> false) digits)
  then None
  else
    let limit = max_int / 1000 in
    let seconds =
      String.fold_left
        (fun total char ->
          let digit = Char.code char - Char.code '0' in
          if total > (limit - digit) / 10 then limit else (total * 10) + digit)
        0 digits
    in
    Some (seconds * 1000)

let sleep_ms clock milliseconds =
  let nanos = min 9.22e18 (max 0. milliseconds *. 1_000_000.) in
  let span = Mtime.Span.of_uint64_ns (Int64.of_float (ceil nanos)) in
  let deadline =
    Mtime.add_span (Clock.monotonic_now clock) span
    |> Option.value ~default:Mtime.max_stamp
  in
  Clock.sleep_until clock deadline

let retry_with_backoff ~clock ~budget ~accepts ~retry_after attempt =
  if
    budget.attempts < 1
    || budget.initial_delay_ms < 0
    || budget.max_delay_ms < budget.initial_delay_ms
  then invalid_arg "invalid retry budget";
  let rec run left cap =
    match attempt () with
    | Error failure when left > 1 && accepts failure ->
        let draw = Clock.jitter clock in
        if not (draw >= 0. && draw <= 1.) then
          invalid_arg "invalid retry jitter";
        let minimum = Option.value (retry_after failure) ~default:0 in
        if minimum < 0 then invalid_arg "invalid retry-after";
        sleep_ms clock
          (max (float minimum) (float cap *. (0.5 +. (draw *. 0.5))));
        run (left - 1) (cap + min cap (budget.max_delay_ms - cap))
    | outcome -> outcome
  in
  run budget.attempts budget.initial_delay_ms
