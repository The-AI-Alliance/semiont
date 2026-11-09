type kind = Client | Producer | Consumer
type attribute = String of string | Int of int | Bool of bool

type span = {
  trace : Wire_stream.trace option;
  name : string;
  kind : kind;
  attributes : (string * attribute) list;
  started : float;
  ended : float;
}

type counter = {
  name : string;
  attributes : (string * attribute) list;
  time : float;
}

type t = { span : span -> unit; increment : counter -> unit }

let around ?trace telemetry ~clock (name, kind) attributes f =
  match telemetry with
  | None -> f ()
  | Some sink ->
      let started = Clock.wall_now clock in
      Fun.protect
        ~finally:(fun () ->
          let ended = Clock.wall_now clock in
          sink.span { trace; name; kind; attributes; started; ended })
        f
