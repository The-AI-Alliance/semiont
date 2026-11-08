type 'a t = { mutable run : (unit -> 'a) option }

let make run = { run = Some run }

let await t =
  match t.run with
  | None -> invalid_arg "operation already consumed"
  | Some run ->
      t.run <- None;
      run ()
