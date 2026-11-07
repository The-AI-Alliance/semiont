type t = {
  monotonic_now : unit -> Mtime.t;
  sleep_until : Mtime.t -> unit;
  wall_now : unit -> float;
  jitter : Random.State.t;
}

let make ~monotonic ~wall ~jitter =
  {
    monotonic_now = (fun () -> Eio.Time.Mono.now monotonic);
    sleep_until = Eio.Time.Mono.sleep_until monotonic;
    wall_now = (fun () -> Eio.Time.now wall);
    jitter;
  }

let monotonic_now t = t.monotonic_now ()
let sleep_until t = t.sleep_until
let wall_now t = t.wall_now ()
let jitter t = Random.State.float t.jitter 1.
