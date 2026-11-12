(* What is said before anyone reads is kept for the first reader: the latest
   errorsKeptForFirstReaderCount (protocol/specs/src/client/timing.json), in
   the order said, the oldest dropped beyond them. A later reader hears what is
   said from when it reads. Closing drops what is still kept, and a reader who
   comes after hears only the end. *)

type 'a reader = {
  hear : 'a -> unit;
  ended : unit -> unit;
  mutable active : bool;
}

type 'a state = Keeping of 'a Queue.t | Read of 'a reader list | Closed
type 'a t = { mutable state : 'a state }

let make () = { state = Keeping (Queue.create ()) }

let say t value =
  match t.state with
  | Keeping kept ->
      Queue.push value kept;
      if Queue.length kept > Client_timing.errors_kept_for_first_reader_count
      then ignore (Queue.pop kept)
  | Read readers ->
      List.iter (fun reader -> if reader.active then reader.hear value) readers
  | Closed -> ()

let read t ~on_value ~on_close =
  let reader = { hear = on_value; ended = on_close; active = true } in
  let release () =
    reader.active <- false;
    match t.state with
    | Read readers ->
        t.state <- Read (List.filter (fun other -> other != reader) readers)
    | Keeping _ | Closed -> ()
  in
  match t.state with
  | Closed ->
      on_close ();
      Fun.id
  | Read readers ->
      t.state <- Read (readers @ [ reader ]);
      release
  | Keeping kept ->
      t.state <- Read [ reader ];
      Queue.iter on_value kept;
      release

let close t =
  match t.state with
  | Closed -> ()
  | Keeping _ -> t.state <- Closed
  | Read readers ->
      t.state <- Closed;
      List.iter
        (fun reader ->
          if reader.active then (
            reader.active <- false;
            reader.ended ()))
        readers
