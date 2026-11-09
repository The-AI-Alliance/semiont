type kind = Object | Array | String | Integer | Number | Boolean | Null

type t = {
  reference : string option;
  kinds : kind list option;
  enum : Yojson.Raw.t list option;
  pattern : ((int * int) list * int * int option) list option;
  min_length : int option;
  max_length : int option;
  minimum : string option;
  maximum : string option;
  min_items : int option;
  max_items : int option;
  required : string list;
  members : (string * t) list;
  closed : string list option;
  items : t option;
  values : t option;
  variants : t list;
  discriminator : (string * (string * int) list) option;
  all_of : t list;
}

let any =
  {
    reference = None;
    kinds = None;
    enum = None;
    pattern = None;
    min_length = None;
    max_length = None;
    minimum = None;
    maximum = None;
    min_items = None;
    max_items = None;
    required = [];
    members = [];
    closed = None;
    items = None;
    values = None;
    variants = [];
    discriminator = None;
    all_of = [];
  }

let reference name = { any with reference = Some name }

let object_ ?(required = []) ?(members = []) ?closed () =
  { any with kinds = Some [ Object ]; required; members; closed }
