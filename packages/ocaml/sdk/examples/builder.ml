open Semiont

let read_resource client resource =
  Client.fresh (Client.Browse.resource client resource)

let watch_resource client resource ~on_state ~on_close =
  Client.observe (Client.Browse.resource client resource) ~on_state ~on_close

let mark_resource client resource ~on_report ~on_failure ~on_close =
  Result.map
    (fun params ->
      Client.Mark.delegate (Client.delegation client) ~resource ~params
        ~on_report ~on_failure ~on_close ())
    (Models.decode Models.mark_job_params {|{"motivation":"highlighting"}|})
