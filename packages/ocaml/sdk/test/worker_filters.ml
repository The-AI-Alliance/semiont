(* Shared worker filter cases from jobs/filter-cases.json. *)
let () =
  let open Yojson.Safe.Util in
  Yojson.Safe.from_string Job_filter_cases.cases
  |> to_list
  |> List.iter (fun row ->
      let filters = `List [ member "filter" row ] in
      let announcement = member "job" row in
      Alcotest.(check bool)
        (member "why" row |> to_string)
        (member "matches" row |> to_bool)
        (Semiont.Worker.accepts ~filters ~announcement))
