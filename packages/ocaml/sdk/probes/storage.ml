open Eio.Std

let check = Alcotest.(check bool)

let directory use =
  let path = Filename.temp_file "semiont-native-lock-" "" in
  Unix.unlink path;
  Unix.mkdir path Store_policy.directory_mode;
  Fun.protect
    ~finally:(fun () ->
      Array.iter
        (fun name -> Unix.unlink (Filename.concat path name))
        (Sys.readdir path);
      Unix.rmdir path)
    (fun () -> use path)

let open_lock path =
  Unix.openfile path
    [ Unix.O_CREAT; Unix.O_RDWR; Unix.O_CLOEXEC ]
    Store_policy.file_mode

let independent_holder env ~sw path =
  let mgr = Eio.Stdenv.process_mgr env in
  let output, child_output = Eio.Process.pipe ~sw mgr in
  let child_input, input = Eio.Process.pipe ~sw mgr in
  let process =
    Eio.Process.spawn ~sw mgr ~stdin:child_input ~stdout:child_output
      [ "python3"; "lock_holder.py"; path ]
  in
  Eio.Resource.close child_input;
  Eio.Resource.close child_output;
  Alcotest.(check string)
    "independent holder acquired flock" "held"
    Eio.Buf_read.(line (of_flow ~max_size:1024 output));
  (process, input)

let interoperability () =
  Eio_main.run @@ fun env ->
  directory @@ fun directory ->
  let path = Filename.concat directory "lock" in
  let fd = open_lock path in
  Fun.protect ~finally:(fun () -> Unix.close fd) @@ fun () ->
  Switch.run @@ fun sw ->
  let process, input = independent_holder env ~sw path in
  check "C flock excludes Python's real flock" false
    (Native_lock.try_exclusive fd);
  Eio.Flow.copy_string "exit\n" input;
  Eio.Process.await_exn process;
  check "process death releases flock" true (Native_lock.try_exclusive fd);
  let competing = open_lock path in
  Fun.protect ~finally:(fun () -> Unix.close competing) @@ fun () ->
  check "another open description is excluded" false
    (Native_lock.try_exclusive competing);
  Native_lock.unlock fd;
  check "explicit unlock releases ownership" true
    (Native_lock.try_exclusive competing);
  Native_lock.unlock competing

let cancelled_acquisition () =
  Eio_main.run @@ fun env ->
  directory @@ fun directory ->
  let path = Filename.concat directory "lock" in
  let original = open_lock path in
  Unix.close original;
  Switch.run @@ fun sw ->
  let process, input = independent_holder env ~sw path in
  let clock = Eio_mock.Clock.Mono.make () in
  let blocked, block = Promise.create () in
  let descriptor = ref None in
  let cc, receive_cc = Promise.create () in
  let waiter =
    Fiber.fork_promise ~sw (fun () ->
        try
          Eio.Cancel.sub (fun cancel ->
              Promise.resolve receive_cc cancel;
              let fd = open_lock path in
              descriptor := Some fd;
              Fun.protect
                ~finally:(fun () -> Unix.close fd)
                (fun () ->
                  check "lock remains owned by independent process" false
                    (Native_lock.try_exclusive fd);
                  Promise.resolve block ();
                  Eio.Time.Mono.sleep clock 1.;
                  check "cancelled acquisition cannot resume" false true;
                  false))
        with Eio.Cancel.Cancelled _ -> true)
  in
  let cancel = Promise.await cc in
  Promise.await blocked;
  Eio.Cancel.cancel cancel Exit;
  check "cancellation escapes acquisition" true (Promise.await_exn waiter);
  let fd = Option.get !descriptor in
  let closed =
    try
      ignore (Unix.fstat fd);
      false
    with Unix.Unix_error (Unix.EBADF, _, _) -> true
  in
  check "cancelled acquisition closes its descriptor" true closed;
  Eio.Flow.copy_string "exit\n" input;
  Eio.Process.await_exn process;
  let fd = open_lock path in
  Fun.protect
    ~finally:(fun () -> Unix.close fd)
    (fun () ->
      check "cancellation left no lock behind" true
        (Native_lock.try_exclusive fd))

let atomic_replace () =
  directory @@ fun directory ->
  let target = Filename.concat directory "document" in
  let lock = Filename.concat directory "lock" in
  let fd = open_lock lock in
  Fun.protect ~finally:(fun () -> Unix.close fd) @@ fun () ->
  check "writer owns lock" true (Native_lock.try_exclusive fd);
  let lock_inode = (Unix.fstat fd).Unix.st_ino in
  let write contents ~before_rename =
    let temp = Filename.concat directory "document.new" in
    let out =
      Unix.openfile temp
        [ Unix.O_CREAT; Unix.O_EXCL; Unix.O_WRONLY; Unix.O_CLOEXEC ]
        Store_policy.file_mode
    in
    Fun.protect
      ~finally:(fun () -> if Sys.file_exists temp then Unix.unlink temp)
      (fun () ->
        Fun.protect
          ~finally:(fun () -> Unix.close out)
          (fun () ->
            let rec all at =
              if at < String.length contents then (
                let written =
                  Unix.write_substring out contents at
                    (String.length contents - at)
                in
                if written = 0 then failwith "zero-length write";
                all (at + written))
            in
            all 0;
            Unix.fsync out);
        before_rename ();
        Unix.rename temp target)
  in
  write "complete old document" ~before_rename:ignore;
  let old = Unix.openfile target [ Unix.O_RDONLY; Unix.O_CLOEXEC ] 0 in
  Fun.protect ~finally:(fun () -> Unix.close old) @@ fun () ->
  let failed =
    try
      write "partial" ~before_rename:(fun () -> raise Exit);
      false
    with Exit -> true
  in
  check "failure was injected before replace" true failed;
  check "failed replacement removes its temporary file" false
    (Sys.file_exists (Filename.concat directory "document.new"));
  Alcotest.(check string)
    "failed replacement preserves the previous document" "complete old document"
    (In_channel.with_open_bin target In_channel.input_all);
  write "complete new document" ~before_rename:ignore;
  let bytes = Bytes.create 21 in
  let length = Unix.read old bytes 0 (Bytes.length bytes) in
  Alcotest.(check string)
    "old open reader retains a whole document" "complete old document"
    (Bytes.sub_string bytes 0 length);
  Alcotest.(check string)
    "new reader sees a whole replacement" "complete new document"
    (In_channel.with_open_bin target In_channel.input_all);
  Alcotest.(check int)
    "lock inode is not renamed" lock_inode (Unix.stat lock).Unix.st_ino;
  Alcotest.(check int)
    "directory is owner-only" Store_policy.directory_mode
    (Unix.stat directory).Unix.st_perm;
  List.iter
    (fun path ->
      Alcotest.(check int)
        "file is owner-only" Store_policy.file_mode
        (Unix.stat path).Unix.st_perm)
    [ target; lock ]

let () =
  Alcotest.run "OCaml native store substrate"
    [
      ( "flock",
        [
          Alcotest.test_case "cross-process exclusion and process death" `Quick
            interoperability;
          Alcotest.test_case "cancelled acquisition releases descriptor" `Quick
            cancelled_acquisition;
        ] );
      ( "replace",
        [
          Alcotest.test_case "atomic owner-only replacement and failure cleanup"
            `Quick atomic_replace;
        ] );
    ]
