(* Generated from protocol identifier kinds and shared required shapes. Do not edit. *)
let () =
  Alcotest.(check bool) "ResourceId: as the knowledge base mints one" true
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "5bcd259ab1464cf68a556bbad21f513f"));
  Alcotest.(check bool) "ResourceId: the scope events about the knowledge base itself are logged under" true
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "__system__"));
  Alcotest.(check bool) "ResourceId: how an id is made is not part of the rule" true
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "res-one"));
  Alcotest.(check bool) "ResourceId: 128 characters" true
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  Alcotest.(check bool) "ResourceId: an id names something" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string ""));
  Alcotest.(check bool) "ResourceId: an id is one name in a file system, and this one names the directory above" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string ".."));
  Alcotest.(check bool) "ResourceId: and this one the directory itself" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "."));
  Alcotest.(check bool) "ResourceId: no `.` at all: a store appends an extension to an id to name a file" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "a.json"));
  Alcotest.(check bool) "ResourceId: an id is one segment of a path" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "a/b"));
  Alcotest.(check bool) "ResourceId: on any file system" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "a\092b"));
  Alcotest.(check bool) "ResourceId: a URI is not an id: the id is its last segment" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "https://kb.example/resources/5bcd259ab1464cf68a556bbad21f513f"));
  Alcotest.(check bool) "ResourceId: no whitespace" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "a b"));
  Alcotest.(check bool) "ResourceId: a line end is whitespace too, at the end as anywhere" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "abc\010"));
  Alcotest.(check bool) "ResourceId: nothing that needs encoding, and nothing already encoded" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "a%2Fb"));
  Alcotest.(check bool) "ResourceId: nothing a URL reads as its own" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "a?b"));
  Alcotest.(check bool) "ResourceId: nothing a URL reads as its own" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "a#b"));
  Alcotest.(check bool) "ResourceId: ASCII only: one spelling, on every file system" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "na\195\175ve"));
  Alcotest.(check bool) "ResourceId: 129 characters: a file's name has a limit, and an id is well inside it" false
    (Result.is_ok (Semiont.Identifiers.Resource_id.of_string "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  Alcotest.(check bool) "AnnotationId: as the knowledge base mints one" true
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "5bcd259ab1464cf68a556bbad21f513f"));
  Alcotest.(check bool) "AnnotationId: how an id is made is not part of the rule" true
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a-1"));
  Alcotest.(check bool) "AnnotationId: 128 characters" true
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  Alcotest.(check bool) "AnnotationId: an id names something" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string ""));
  Alcotest.(check bool) "AnnotationId: an id is one name in a file system, and this one names the directory above" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string ".."));
  Alcotest.(check bool) "AnnotationId: and this one the directory itself" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "."));
  Alcotest.(check bool) "AnnotationId: no `.` at all: a store appends an extension to an id to name a file" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a.json"));
  Alcotest.(check bool) "AnnotationId: an id is one segment of a path" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a/b"));
  Alcotest.(check bool) "AnnotationId: on any file system" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a\092b"));
  Alcotest.(check bool) "AnnotationId: a URI is not an id: the id is its last segment" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "https://kb.example/resources/5bcd259ab1464cf68a556bbad21f513f"));
  Alcotest.(check bool) "AnnotationId: no whitespace" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a b"));
  Alcotest.(check bool) "AnnotationId: a line end is whitespace too, at the end as anywhere" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "abc\010"));
  Alcotest.(check bool) "AnnotationId: nothing that needs encoding, and nothing already encoded" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a%2Fb"));
  Alcotest.(check bool) "AnnotationId: nothing a URL reads as its own" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a?b"));
  Alcotest.(check bool) "AnnotationId: nothing a URL reads as its own" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "a#b"));
  Alcotest.(check bool) "AnnotationId: ASCII only: one spelling, on every file system" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "na\195\175ve"));
  Alcotest.(check bool) "AnnotationId: 129 characters: a file's name has a limit, and an id is well inside it" false
    (Result.is_ok (Semiont.Identifiers.Annotation_id.of_string "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  Alcotest.(check bool) "JobId: as the dispatcher mints one" true
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "job-5bcd259ab1464cf68a556bbad21f513f"));
  Alcotest.(check bool) "JobId: how an id is made is not part of the rule" true
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "job-1"));
  Alcotest.(check bool) "JobId: 128 characters" true
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  Alcotest.(check bool) "JobId: an id names something" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string ""));
  Alcotest.(check bool) "JobId: an id is one name in a file system, and this one names the directory above" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string ".."));
  Alcotest.(check bool) "JobId: and this one the directory itself" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "."));
  Alcotest.(check bool) "JobId: no `.` at all: a store appends an extension to an id to name a file" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "a.json"));
  Alcotest.(check bool) "JobId: an id is one segment of a path" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "a/b"));
  Alcotest.(check bool) "JobId: on any file system" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "a\092b"));
  Alcotest.(check bool) "JobId: a URI is not an id: the id is its last segment" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "https://kb.example/resources/5bcd259ab1464cf68a556bbad21f513f"));
  Alcotest.(check bool) "JobId: no whitespace" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "a b"));
  Alcotest.(check bool) "JobId: a line end is whitespace too, at the end as anywhere" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "abc\010"));
  Alcotest.(check bool) "JobId: nothing that needs encoding, and nothing already encoded" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "a%2Fb"));
  Alcotest.(check bool) "JobId: nothing a URL reads as its own" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "a?b"));
  Alcotest.(check bool) "JobId: nothing a URL reads as its own" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "a#b"));
  Alcotest.(check bool) "JobId: ASCII only: one spelling, on every file system" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "na\195\175ve"));
  Alcotest.(check bool) "JobId: 129 characters: a file's name has a limit, and an id is well inside it" false
    (Result.is_ok (Semiont.Identifiers.Job_id.of_string "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  Alcotest.(check bool) "UserId: a person" true
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "did:web:kb.example:users:alice"));
  Alcotest.(check bool) "UserId: a software agent" true
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "did:web:kb.example:agents:semiont-worker"));
  Alcotest.(check bool) "UserId: a domain with a port, and a subject, both percent-encoded" true
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "did:web:localhost%3A4000:users:a%40b.example"));
  Alcotest.(check bool) "UserId: a subject is the issuer's, and its encoding leaves these as they are" true
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "did:web:kb.example:users:o'brien!"));
  Alcotest.(check bool) "UserId: an id names someone" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string ""));
  Alcotest.(check bool) "UserId: a name is not an identity" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "alice"));
  Alcotest.(check bool) "UserId: nor is an address" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "alice@kb.example"));
  Alcotest.(check bool) "UserId: nor is a row in a table" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "user-123"));
  Alcotest.(check bool) "UserId: a DID names something" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "did:"));
  Alcotest.(check bool) "UserId: no whitespace" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "did:web:kb.example:users:a b"));
  Alcotest.(check bool) "UserId: a line end is whitespace too" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string "did:web:kb.example:users:alice\010"));
  Alcotest.(check bool) "UserId: no whitespace, before it either" false
    (Result.is_ok (Semiont.Identifiers.User_id.of_string " did:web:kb.example:users:alice"));
  ()
