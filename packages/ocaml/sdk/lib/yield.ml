let delegate follower ?stall_ms ~params ~on_report ~on_failure ~on_close () =
  Delegation.start follower ~verb:"yield" ?stall_ms
    ~params:(Yojson.Safe.from_string (Models.encode params))
    ~on_report ~on_failure ~on_close ()
