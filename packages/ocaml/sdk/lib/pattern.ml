let matches steps text =
  let valid = ref true in
  let points = Uutf.String.fold_utf_8
      (fun points _ -> function
        | `Uchar point -> Uchar.to_int point :: points
        | `Malformed _ -> valid := false; points)
      [] text |> List.rev |> Array.of_list in
  let length = Array.length points in
  let rec walk position = function
    | [] -> position = length
    | (ranges, minimum, maximum) :: rest ->
      let limit = match maximum with None -> length - position | Some n -> n in
      let rec count n =
        if n < limit && position + n < length &&
           List.exists (fun (lo, hi) -> lo <= points.(position + n) && points.(position + n) <= hi) ranges
        then count (n + 1) else n in
      let rec attempt n =
        n >= minimum && (walk (position + n) rest || attempt (n - 1)) in
      attempt (count 0)
  in
  !valid && walk 0 steps
