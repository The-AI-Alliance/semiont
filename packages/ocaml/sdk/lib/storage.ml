type t = {
  get : string -> string option;
  update : string -> (string option -> string option) -> unit;
  subscribe : (string -> (string option -> unit) -> unit -> unit) option;
}

let make ~get ~update ?subscribe () = { get; update; subscribe }
let get t = t.get
let update t = t.update
let set t key value = update t key (fun _ -> Some value)
let delete t key = update t key (fun _ -> None)

let subscribe t key observe =
  Option.map (fun subscribe -> subscribe key observe) t.subscribe
