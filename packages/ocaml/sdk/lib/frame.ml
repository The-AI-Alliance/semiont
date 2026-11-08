include Namespace_methods.Frame

let rec add_entity_types client = function
  | [] -> Ok ()
  | payload :: rest ->
      Result.bind (add_entity_type client payload) (fun _ ->
          add_entity_types client rest)
