let job_matches_filter filter announcement =
  Worker.accepts
    ~filters:(`List [ Yojson.Safe.from_string (Models.encode filter) ])
    ~announcement:(Yojson.Safe.from_string (Models.encode announcement))
