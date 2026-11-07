open Types

let text value = `String value
let names values = `List (List.map (fun id -> text (Ident.name id)) values)
let declaration item = text (Format.asprintf "%a" Printtyp.signature [ item ])

let row kind path item extra =
  `Assoc
    ([
       ("kind", text kind);
       ("path", text path);
       ("declaration", declaration item);
     ]
    @ extra)

let rec signature env prefix seen items =
  let env = Env.add_signature items env in
  List.concat_map
    (fun item ->
      if Types.item_visibility item = Hidden then []
      else
        let id = Types.signature_item_id item in
        let path = prefix ^ "." ^ Ident.name id in
        match item with
        | Sig_value _ -> [ row "value" path item [] ]
        | Sig_type (_, definition, _, _) ->
            let detail =
              match definition.type_kind with
              | Type_abstract _ -> [ ("representation", text "abstract") ]
              | Type_external name ->
                  [
                    ("representation", text "external"); ("external", text name);
                  ]
              | Type_open -> [ ("representation", text "open") ]
              | Type_record (fields, _) ->
                  [
                    ("representation", text "record");
                    ( "fields",
                      names (List.map (fun field -> field.ld_id) fields) );
                  ]
              | Type_variant (constructors, _) ->
                  [
                    ("representation", text "variant");
                    ( "constructors",
                      names
                        (List.map
                           (fun constructor -> constructor.cd_id)
                           constructors) );
                  ]
            in
            [ row "type" path item detail ]
        | Sig_module (_, _, definition, _, _) ->
            let alias =
              match definition.md_type with
              | Mty_alias target -> [ ("alias", text (Path.name target)) ]
              | _ -> []
            in
            row "module" path item alias
            :: module_type env path seen definition.md_type
        | Sig_modtype (_, definition, _) ->
            row "module_type" path item []
            ::
            (match definition.mtd_type with
            | None -> []
            | Some kind -> module_type env path seen kind)
        | Sig_typext _ -> [ row "extension" path item [] ]
        | Sig_class _ -> [ row "class" path item [] ]
        | Sig_class_type _ -> [ row "class_type" path item [] ])
    items

and module_type env path seen kind =
  match kind with
  | Mty_signature items -> signature env path seen items
  | Mty_alias target ->
      let name = Path.name target in
      if List.mem name seen then failwith ("cyclic module alias: " ^ name);
      let definition = Env.find_module target env in
      module_type env path (name :: seen) definition.md_type
  | Mty_ident target -> (
      let name = Path.name target in
      if List.mem name seen then failwith ("cyclic module type: " ^ name);
      let definition = Env.find_modtype target env in
      match definition.mtd_type with
      | None -> []
      | Some kind -> module_type env path (name :: seen) kind)
  | Mty_functor (parameter, result) ->
      let parameters, env =
        match parameter with
        | Unit -> ([], env)
        | Named (name, kind) ->
            let label =
              match name with None -> "_" | Some id -> Ident.name id
            in
            let rows =
              module_type env (path ^ ".parameter:" ^ label) seen kind
            in
            let env =
              match name with
              | None -> env
              | Some id -> Env.add_module id Mp_present kind env
            in
            (rows, env)
      in
      parameters @ module_type env (path ^ ".result") seen result

let () =
  if Array.length Sys.argv < 3 then
    failwith "usage: api_inventory interface.cmi include-directory ...";
  Clflags.include_dirs :=
    List.init (Array.length Sys.argv - 2) (fun index -> Sys.argv.(index + 2));
  Compmisc.init_path ();
  let info = Cmi_format.read_cmi Sys.argv.(1) in
  let rows =
    signature (Compmisc.initial_env ()) info.cmi_name [] info.cmi_sign
  in
  Yojson.Basic.pretty_to_channel stdout
    (`Assoc [ ("compiler", text Sys.ocaml_version); ("entries", `List rows) ]);
  print_newline ()
