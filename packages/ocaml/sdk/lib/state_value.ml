type 'a listener = {
  receive : 'a -> unit;
  ended : unit -> unit;
  mutable active : bool;
}

type 'a t = {
  mutable value : 'a;
  mutable closed : bool;
  mutable listeners : 'a listener list;
}

type 'a writer = 'a t

let make value =
  let t = { value; closed = false; listeners = [] } in
  (t, t)

let get t = t.value

let observe t ~on_value ~on_close =
  if t.closed then (
    on_close ();
    Fun.id)
  else
    let listener = { receive = on_value; ended = on_close; active = true } in
    t.listeners <- listener :: t.listeners;
    on_value t.value;
    fun () ->
      listener.active <- false;
      t.listeners <- List.filter (fun entry -> entry != listener) t.listeners

let set ?(repeat = false) t value =
  if (not t.closed) && (repeat || t.value <> value) then (
    t.value <- value;
    List.iter
      (fun listener -> if listener.active then listener.receive value)
      (List.rev t.listeners))

let close t =
  if not t.closed then (
    t.closed <- true;
    let listeners = List.rev t.listeners in
    t.listeners <- [];
    List.iter
      (fun listener ->
        if listener.active then (
          listener.active <- false;
          listener.ended ()))
      listeners)
