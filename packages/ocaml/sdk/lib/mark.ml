include Namespace_methods.Mark

let delegate follower ~resource ~params ~on_report ~on_failure ~on_close () =
  Delegation.start follower ~verb:"mark"
    ~resource:(Identifiers.Resource_id.to_string resource)
    ~params:(Yojson.Safe.from_string (Models.encode params))
    ~on_report ~on_failure ~on_close ()
