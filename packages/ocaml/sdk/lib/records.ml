(* Generated from OpenAPI object components and discriminator mappings. Do not edit. *)

[@@@ocamlformat "disable"]

let object_fields = function `Assoc fields -> fields | _ -> assert false
let string = function
  | `Stringlit literal -> (match Yojson.Safe.from_string literal with `String text -> text | _ -> assert false)
  | _ -> assert false
let bool = function `Bool value -> value | _ -> assert false
let required read name fields = read (List.assoc name fields)
let optional read name fields =
  match List.assoc_opt name fields with
  | None -> Types.Absent | Some `Null -> Types.Null | Some value -> Types.Present (read value)
let identity value = value
let extra names = List.filter (fun (name, _) -> not (List.mem name names))
module Agent_organization = struct
  type t = { field_type : string; field_id : string Types.presence; name : string; homepage : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_type = required string "@type" fields;
      field_id = optional string "@id" fields;
      name = required string "name" fields;
      homepage = optional string "homepage" fields;
      extra = extra ["@type"; "@id"; "name"; "homepage"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Agent_person = struct
  type t = { field_type : string; field_id : string Types.presence; name : string Types.presence; nickname : string Types.presence; email : string Types.presence; email_sha1 : string Types.presence; homepage : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_type = required string "@type" fields;
      field_id = optional string "@id" fields;
      name = optional string "name" fields;
      nickname = optional string "nickname" fields;
      email = optional string "email" fields;
      email_sha1 = optional string "email_sha1" fields;
      homepage = optional string "homepage" fields;
      extra = extra ["@type"; "@id"; "name"; "nickname"; "email"; "email_sha1"; "homepage"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Agent_software = struct
  type t = { field_type : string; field_id : string Types.presence; name : string Types.presence; provider : string Types.presence; model : string Types.presence; parameters : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_type = required string "@type" fields;
      field_id = optional string "@id" fields;
      name = optional string "name" fields;
      provider = optional string "provider" fields;
      model = optional string "model" fields;
      parameters = optional identity "parameters" fields;
      extra = extra ["@type"; "@id"; "name"; "provider"; "model"; "parameters"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Annotation = struct
  type t = { field_context : string; type_ : string; id : Yojson.Raw.t; motivation : Yojson.Raw.t; target : Yojson.Raw.t; body : Yojson.Raw.t Types.presence; creator : Yojson.Raw.t Types.presence; created : string; modified : string Types.presence; generator : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_context = required string "@context" fields;
      type_ = required string "type" fields;
      id = required identity "id" fields;
      motivation = required identity "motivation" fields;
      target = required identity "target" fields;
      body = optional identity "body" fields;
      creator = optional identity "creator" fields;
      created = required string "created" fields;
      modified = optional string "modified" fields;
      generator = optional identity "generator" fields;
      was_attributed_to = optional identity "wasAttributedTo" fields;
      extra = extra ["@context"; "type"; "id"; "motivation"; "target"; "body"; "creator"; "created"; "modified"; "generator"; "wasAttributedTo"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Annotation_added_payload = struct
  type t = { annotation : Yojson.Raw.t; content_checksum : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation = required identity "annotation" fields;
      content_checksum = optional string "contentChecksum" fields;
      extra = extra ["annotation"; "contentChecksum"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Annotation_body_updated_payload = struct
  type t = { annotation_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      operations = required identity "operations" fields;
      extra = extra ["annotationId"; "operations"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Annotation_removed_payload = struct
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      extra = extra ["annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Annotation_target = struct
  type t = { type_ : string Types.presence; source : Yojson.Raw.t; selector : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = optional string "type" fields;
      source = required identity "source" fields;
      selector = optional identity "selector" fields;
      extra = extra ["type"; "source"; "selector"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Attributed_event = struct
  type t = { id : string; type_ : string; timestamp : string; user_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; version : Yojson.Raw.t; payload : Yojson.Raw.t; metadata : Yojson.Raw.t; agent : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required string "id" fields;
      type_ = required string "type" fields;
      timestamp = required string "timestamp" fields;
      user_id = required identity "userId" fields;
      resource_id = optional identity "resourceId" fields;
      version = required identity "version" fields;
      payload = required identity "payload" fields;
      metadata = required identity "metadata" fields;
      agent = required identity "agent" fields;
      extra = extra ["id"; "type"; "timestamp"; "userId"; "resourceId"; "version"; "payload"; "metadata"; "agent"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Beckon_focus_event = struct
  type t = { annotation_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = optional identity "annotationId" fields;
      resource_id = required identity "resourceId" fields;
      extra = extra ["annotationId"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Beckon_hover_event = struct
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      extra = extra ["annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Beckon_sparkle_event = struct
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      extra = extra ["annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bind_body_operation = struct
  type t = { op : string; item : Yojson.Raw.t Types.presence; old_item : Yojson.Raw.t Types.presence; new_item : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      op = required string "op" fields;
      item = optional identity "item" fields;
      old_item = optional identity "oldItem" fields;
      new_item = optional identity "newItem" fields;
      extra = extra ["op"; "item"; "oldItem"; "newItem"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bind_initiate_command = struct
  type t = { annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; default_title : string; entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      resource_id = required identity "resourceId" fields;
      default_title = required string "defaultTitle" fields;
      entity_types = required identity "entityTypes" fields;
      extra = extra ["annotationId"; "resourceId"; "defaultTitle"; "entityTypes"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bind_update_body_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      annotation_id = required identity "annotationId" fields;
      resource_id = required identity "resourceId" fields;
      operations = required identity "operations" fields;
      extra = extra ["_userId"; "annotationId"; "resourceId"; "operations"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Body_operation_add = struct
  type t = { op : string; item : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      op = required string "op" fields;
      item = required identity "item" fields;
      extra = extra ["op"; "item"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Body_operation_remove = struct
  type t = { op : string; item : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      op = required string "op" fields;
      item = required identity "item" fields;
      extra = extra ["op"; "item"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Body_operation_replace = struct
  type t = { op : string; old_item : Yojson.Raw.t; new_item : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      op = required string "op" fields;
      old_item = required identity "oldItem" fields;
      new_item = required identity "newItem" fields;
      extra = extra ["op"; "oldItem"; "newItem"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_engines_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_profiles_request = struct
  type t = { dids : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      dids = required identity "dids" fields;
      extra = extra ["dids"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_profiles_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_annotation_history_request = struct
  type t = { resource_id : Yojson.Raw.t; annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      annotation_id = required identity "annotationId" fields;
      extra = extra ["resourceId"; "annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_annotation_history_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_annotation_request = struct
  type t = { resource_id : Yojson.Raw.t; annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      annotation_id = required identity "annotationId" fields;
      extra = extra ["resourceId"; "annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_annotation_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_click_event = struct
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      extra = extra ["annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_directory_request = struct
  type t = { path : string; sort : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      path = required string "path" fields;
      sort = optional string "sort" fields;
      extra = extra ["path"; "sort"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_directory_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_directory_result_response = struct
  type t = { path : string; entries : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      path = required string "path" fields;
      entries = required identity "entries" fields;
      extra = extra ["path"; "entries"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_entity_type_clicked_event = struct
  type t = { entity_type : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      entity_type = required string "entityType" fields;
      extra = extra ["entityType"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_entity_types_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_events_request = struct
  type t = { resource_id : Yojson.Raw.t; type_ : string Types.presence; user_id : Yojson.Raw.t Types.presence; limit : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      type_ = optional string "type" fields;
      user_id = optional identity "userId" fields;
      limit = optional identity "limit" fields;
      extra = extra ["resourceId"; "type"; "userId"; "limit"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_events_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_external_navigate_event = struct
  type t = { url : string; resource_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      url = required string "url" fields;
      resource_id = optional identity "resourceId" fields;
      extra = extra ["url"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_files_response = struct
  type t = { path : string; entries : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      path = required string "path" fields;
      entries = required identity "entries" fields;
      extra = extra ["path"; "entries"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_kb_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_link_clicked_event = struct
  type t = { href : string; label : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      href = required string "href" fields;
      label = optional string "label" fields;
      extra = extra ["href"; "label"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_panel_open_event = struct
  type t = { panel : string; scroll_to_annotation_id : Yojson.Raw.t Types.presence; motivation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      panel = required string "panel" fields;
      scroll_to_annotation_id = optional identity "scrollToAnnotationId" fields;
      motivation = optional identity "motivation" fields;
      extra = extra ["panel"; "scrollToAnnotationId"; "motivation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_panel_toggle_event = struct
  type t = { panel : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      panel = required string "panel" fields;
      extra = extra ["panel"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resource_open_event = struct
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      extra = extra ["resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resource_viewed_event = struct
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      extra = extra ["resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resource_close_event = struct
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      extra = extra ["resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resource_reorder_event = struct
  type t = { old_index : Yojson.Raw.t; new_index : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      old_index = required identity "oldIndex" fields;
      new_index = required identity "newIndex" fields;
      extra = extra ["oldIndex"; "newIndex"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Anchored_text = struct
  type t = { text : string; items : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      text = required string "text" fields;
      items = required identity "items" fields;
      extra = extra ["text"; "items"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Pdf_text_item = struct
  type t = { start : Yojson.Raw.t; end_ : Yojson.Raw.t; page : Yojson.Raw.t; x : Yojson.Raw.t; y : Yojson.Raw.t; width : Yojson.Raw.t; height : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      start = required identity "start" fields;
      end_ = required identity "end" fields;
      page = required identity "page" fields;
      x = required identity "x" fields;
      y = required identity "y" fields;
      width = required identity "width" fields;
      height = required identity "height" fields;
      extra = extra ["start"; "end"; "page"; "x"; "y"; "width"; "height"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Anchored_text_absent = struct
  type t = { kind : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kind = required string "kind" fields;
      extra = extra ["kind"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resource_request = struct
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      extra = extra ["resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resource_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resources_request = struct
  type t = { archived : bool Types.presence; entity_type : string Types.presence; offset : Yojson.Raw.t Types.presence; limit : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      archived = optional bool "archived" fields;
      entity_type = optional string "entityType" fields;
      offset = optional identity "offset" fields;
      limit = optional identity "limit" fields;
      extra = extra ["archived"; "entityType"; "offset"; "limit"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_resources_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_router_push_event = struct
  type t = { path : string; reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      path = required string "path" fields;
      reason = optional string "reason" fields;
      extra = extra ["path"; "reason"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_tag_schemas_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bus_emit_accepted = struct
  type t = { subscribers : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      subscribers = optional identity "subscribers" fields;
      extra = extra ["subscribers"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bus_emit_request = struct
  type t = { channel : string; payload : Yojson.Raw.t; scope : Yojson.Raw.t Types.presence; client_id : string Types.presence; correlation_id : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      channel = required string "channel" fields;
      payload = required identity "payload" fields;
      scope = optional identity "scope" fields;
      client_id = optional string "clientId" fields;
      correlation_id = optional string "correlationId" fields;
      extra = extra ["channel"; "payload"; "scope"; "clientId"; "correlationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bus_subscribe_request = struct
  type t = { global : Yojson.Raw.t Types.presence; pending_replies : Yojson.Raw.t Types.presence; scoped : Yojson.Raw.t Types.presence; client_id : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      global = optional identity "global" fields;
      pending_replies = optional identity "pendingReplies" fields;
      scoped = optional identity "scoped" fields;
      client_id = required string "clientId" fields;
      extra = extra ["global"; "pendingReplies"; "scoped"; "clientId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Clone_resource_with_token_response = struct
  type t = { token : string; expires_at : string; resource : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      token = required string "token" fields;
      expires_at = required string "expiresAt" fields;
      resource = required identity "resource" fields;
      extra = extra ["token"; "expiresAt"; "resource"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Engine_entry = struct
  type t = { engine : Yojson.Raw.t; jobs : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      engine = required identity "engine" fields;
      jobs = optional identity "jobs" fields;
      extra = extra ["engine"; "jobs"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Command_error = struct
  type t = { code : string Types.presence; message : string; details : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = optional string "code" fields;
      message = required string "message" fields;
      details = optional string "details" fields;
      extra = extra ["code"; "message"; "details"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Contextual_summary_response = struct
  type t = { summary : string; relevant_fields : Yojson.Raw.t; context : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      summary = required string "summary" fields;
      relevant_fields = required identity "relevantFields" fields;
      context = required identity "context" fields;
      extra = extra ["summary"; "relevantFields"; "context"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Create_annotation_request = struct
  type t = { motivation : Yojson.Raw.t; target : Yojson.Raw.t; body : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      motivation = required identity "motivation" fields;
      target = required identity "target" fields;
      body = optional identity "body" fields;
      extra = extra ["motivation"; "target"; "body"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Create_resource_response = struct
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      extra = extra ["resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Dir_entry = struct
  type t = { type_ : string; name : string; path : string; mtime : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      name = required string "name" fields;
      path = required string "path" fields;
      mtime = required string "mtime" fields;
      extra = extra ["type"; "name"; "path"; "mtime"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Discovered_kb = struct
  type t = { host : string; port : Yojson.Raw.t; placement : string; repo : string Types.presence; did : string; site_name : string Types.presence; managed_by : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      host = required string "host" fields;
      port = required identity "port" fields;
      placement = required string "placement" fields;
      repo = optional string "repo" fields;
      did = required string "did" fields;
      site_name = optional string "siteName" fields;
      managed_by = required string "managedBy" fields;
      extra = extra ["host"; "port"; "placement"; "repo"; "did"; "siteName"; "managedBy"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Discovery_document = struct
  type t = { version : Yojson.Raw.t; kbs : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      version = required identity "version" fields;
      kbs = required identity "kbs" fields;
      extra = extra ["version"; "kbs"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Enriched_resource_event = struct
  type t = { id : string; type_ : string; timestamp : string; user_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; version : Yojson.Raw.t; payload : Yojson.Raw.t; metadata : Yojson.Raw.t; annotation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required string "id" fields;
      type_ = required string "type" fields;
      timestamp = required string "timestamp" fields;
      user_id = required identity "userId" fields;
      resource_id = optional identity "resourceId" fields;
      version = required identity "version" fields;
      payload = required identity "payload" fields;
      metadata = required identity "metadata" fields;
      annotation = optional identity "annotation" fields;
      extra = extra ["id"; "type"; "timestamp"; "userId"; "resourceId"; "version"; "payload"; "metadata"; "annotation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Entity_tag_changed_payload = struct
  type t = { entity_type : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      entity_type = required string "entityType" fields;
      extra = extra ["entityType"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Entity_type_added_payload = struct
  type t = { entity_type : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      entity_type = required string "entityType" fields;
      extra = extra ["entityType"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Error_response = struct
  type t = { error : string; code : string Types.presence; hint : string Types.presence; details : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      error = required string "error" fields;
      code = optional string "code" fields;
      hint = optional string "hint" fields;
      details = optional identity "details" fields;
      extra = extra ["error"; "code"; "hint"; "details"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Event_metadata = struct
  type t = { sequence_number : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      sequence_number = required identity "sequenceNumber" fields;
      extra = extra ["sequenceNumber"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Extracted_text = struct
  type t = { text : string; items : Yojson.Raw.t; kind : string; method_ : string; pdf_class : string Types.presence; ocr_confidence : Yojson.Raw.t Types.presence; unread_pages : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      text = required string "text" fields;
      items = required identity "items" fields;
      kind = required string "kind" fields;
      method_ = required string "method" fields;
      pdf_class = optional string "pdfClass" fields;
      ocr_confidence = optional identity "ocrConfidence" fields;
      unread_pages = optional identity "unreadPages" fields;
      extra = extra ["text"; "items"; "kind"; "method"; "pdfClass"; "ocrConfidence"; "unreadPages"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Extraction_declined = struct
  type t = { kind : string; declined : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kind = required string "kind" fields;
      declined = required string "declined" fields;
      extra = extra ["kind"; "declined"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module File_entry = struct
  type t = { type_ : string; name : string; path : string; size : Yojson.Raw.t; mtime : string; tracked : bool; resource_id : Yojson.Raw.t Types.presence; entity_types : Yojson.Raw.t Types.presence; annotation_count : Yojson.Raw.t Types.presence; creator : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      name = required string "name" fields;
      path = required string "path" fields;
      size = required identity "size" fields;
      mtime = required string "mtime" fields;
      tracked = required bool "tracked" fields;
      resource_id = optional identity "resourceId" fields;
      entity_types = optional identity "entityTypes" fields;
      annotation_count = optional identity "annotationCount" fields;
      creator = optional string "creator" fields;
      extra = extra ["type"; "name"; "path"; "size"; "mtime"; "tracked"; "resourceId"; "entityTypes"; "annotationCount"; "creator"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Fragment_selector = struct
  type t = { type_ : string; value : string; conforms_to : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      value = required string "value" fields;
      conforms_to = optional string "conformsTo" fields;
      extra = extra ["type"; "value"; "conformsTo"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Frame_add_entity_type_command = struct
  type t = { tag : string; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      tag = required string "tag" fields;
      field_user_id = optional identity "_userId" fields;
      extra = extra ["tag"; "_userId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Frame_add_tag_schema_command = struct
  type t = { schema : Yojson.Raw.t; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      schema = required identity "schema" fields;
      field_user_id = optional identity "_userId" fields;
      extra = extra ["schema"; "_userId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_annotation_complete = struct
  type t = { annotation_id : Yojson.Raw.t; response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      response = required identity "response" fields;
      extra = extra ["annotationId"; "response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_annotation_options = struct
  type t = { include_source_context : bool Types.presence; include_target_context : bool Types.presence; context_window : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      include_source_context = optional bool "includeSourceContext" fields;
      include_target_context = optional bool "includeTargetContext" fields;
      context_window = optional identity "contextWindow" fields;
      extra = extra ["includeSourceContext"; "includeTargetContext"; "contextWindow"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_annotation_request = struct
  type t = { annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; options : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      resource_id = required identity "resourceId" fields;
      options = optional identity "options" fields;
      extra = extra ["annotationId"; "resourceId"; "options"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_resource_complete = struct
  type t = { resource_id : Yojson.Raw.t; response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      response = required identity "response" fields;
      extra = extra ["resourceId"; "response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_resource_request = struct
  type t = { resource_id : Yojson.Raw.t; options : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      options = required identity "options" fields;
      extra = extra ["resourceId"; "options"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_resource_request_options = struct
  type t = { depth : Yojson.Raw.t; max_resources : Yojson.Raw.t; include_content : bool; include_summary : bool; exclude_entity_types : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      depth = required identity "depth" fields;
      max_resources = required identity "maxResources" fields;
      include_content = required bool "includeContent" fields;
      include_summary = required bool "includeSummary" fields;
      exclude_entity_types = optional identity "excludeEntityTypes" fields;
      extra = extra ["depth"; "maxResources"; "includeContent"; "includeSummary"; "excludeEntityTypes"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_summary_request = struct
  type t = { annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      resource_id = required identity "resourceId" fields;
      extra = extra ["annotationId"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_referenced_by_request = struct
  type t = { resource_id : Yojson.Raw.t; motivation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      motivation = optional identity "motivation" fields;
      extra = extra ["resourceId"; "motivation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_referenced_by_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gathered_context = struct
  type t = { focus : Yojson.Raw.t; graph : Yojson.Raw.t; semantic_context : Yojson.Raw.t Types.presence; metadata : Yojson.Raw.t; inferred_relationship_summary : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      focus = required identity "focus" fields;
      graph = required identity "graph" fields;
      semantic_context = optional identity "semanticContext" fields;
      metadata = required identity "metadata" fields;
      inferred_relationship_summary = optional string "inferredRelationshipSummary" fields;
      extra = extra ["focus"; "graph"; "semanticContext"; "metadata"; "inferredRelationshipSummary"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Generation_job_params = struct
  type t = { title : string; storage_uri : string; prompt : string Types.presence; entity_types : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; temperature : Yojson.Raw.t Types.presence; max_tokens : Yojson.Raw.t Types.presence; output_media_type : Yojson.Raw.t Types.presence; task : string Types.presence; structure : string Types.presence; cite : bool Types.presence; context : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      title = required string "title" fields;
      storage_uri = required string "storageUri" fields;
      prompt = optional string "prompt" fields;
      entity_types = optional identity "entityTypes" fields;
      language = optional string "language" fields;
      source_language = optional string "sourceLanguage" fields;
      temperature = optional identity "temperature" fields;
      max_tokens = optional identity "maxTokens" fields;
      output_media_type = optional identity "outputMediaType" fields;
      task = optional string "task" fields;
      structure = optional string "structure" fields;
      cite = optional bool "cite" fields;
      context = required identity "context" fields;
      extra = extra ["title"; "storageUri"; "prompt"; "entityTypes"; "language"; "sourceLanguage"; "temperature"; "maxTokens"; "outputMediaType"; "task"; "structure"; "cite"; "context"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_annotation_history_response = struct
  type t = { events : Yojson.Raw.t; total : Yojson.Raw.t; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      events = required identity "events" fields;
      total = required identity "total" fields;
      annotation_id = required identity "annotationId" fields;
      resource_id = required identity "resourceId" fields;
      extra = extra ["events"; "total"; "annotationId"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_annotation_response = struct
  type t = { annotation : Yojson.Raw.t; resource : Yojson.Raw.t; resolved_resource : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation = required identity "annotation" fields;
      resource = required identity "resource" fields;
      resolved_resource = required identity "resolvedResource" fields;
      extra = extra ["annotation"; "resource"; "resolvedResource"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_annotations_response = struct
  type t = { annotations : Yojson.Raw.t; total : Yojson.Raw.t; motivation : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotations = required identity "annotations" fields;
      total = required identity "total" fields;
      motivation = optional identity "motivation" fields;
      extra = extra ["annotations"; "total"; "motivation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_entity_types_response = struct
  type t = { entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      entity_types = required identity "entityTypes" fields;
      extra = extra ["entityTypes"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_events_response = struct
  type t = { events : Yojson.Raw.t; total : Yojson.Raw.t; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      events = required identity "events" fields;
      total = required identity "total" fields;
      resource_id = required identity "resourceId" fields;
      extra = extra ["events"; "total"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_referenced_by_response = struct
  type t = { referenced_by : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      referenced_by = required identity "referencedBy" fields;
      extra = extra ["referencedBy"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_referenced_by_response_referenced_by_item = struct
  type t = { id : Yojson.Raw.t; resource_name : string Types.presence; target : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required identity "id" fields;
      resource_name = optional string "resourceName" fields;
      target = required identity "target" fields;
      extra = extra ["id"; "resourceName"; "target"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_resource_by_token_response = struct
  type t = { source_resource : Yojson.Raw.t; expires_at : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      source_resource = required identity "sourceResource" fields;
      expires_at = required string "expiresAt" fields;
      extra = extra ["sourceResource"; "expiresAt"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_resource_response = struct
  type t = { resource : Yojson.Raw.t; annotations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource = required identity "resource" fields;
      annotations = required identity "annotations" fields;
      extra = extra ["resource"; "annotations"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Get_tag_schemas_response = struct
  type t = { tag_schemas : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      tag_schemas = required identity "tagSchemas" fields;
      extra = extra ["tagSchemas"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Health_response = struct
  type t = { status : string; message : string; version : string; timestamp : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      message = required string "message" fields;
      version = required string "version" fields;
      timestamp = required string "timestamp" fields;
      extra = extra ["status"; "message"; "version"; "timestamp"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Inference_limits = struct
  type t = { context_tokens : Yojson.Raw.t; max_output_tokens : Yojson.Raw.t; accepts_temperature : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      context_tokens = required identity "contextTokens" fields;
      max_output_tokens = required identity "maxOutputTokens" fields;
      accepts_temperature = optional bool "acceptsTemperature" fields;
      extra = extra ["contextTokens"; "maxOutputTokens"; "acceptsTemperature"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Inference_limits_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Engine_limits = struct
  type t = { engine : Yojson.Raw.t; limits : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      engine = required identity "engine" fields;
      limits = required identity "limits" fields;
      extra = extra ["engine"; "limits"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Graph_annotation_node = struct
  type t = { id : Yojson.Raw.t; type_ : string; label : string; entity_types : Yojson.Raw.t Types.presence; annotation : Yojson.Raw.t; metadata : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required identity "id" fields;
      type_ = required string "type" fields;
      label = required string "label" fields;
      entity_types = optional identity "entityTypes" fields;
      annotation = required identity "annotation" fields;
      metadata = optional identity "metadata" fields;
      extra = extra ["id"; "type"; "label"; "entityTypes"; "annotation"; "metadata"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Graph_resource_node = struct
  type t = { id : Yojson.Raw.t; type_ : string; label : string; entity_types : Yojson.Raw.t Types.presence; metadata : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required identity "id" fields;
      type_ = required string "type" fields;
      label = required string "label" fields;
      entity_types = optional identity "entityTypes" fields;
      metadata = optional identity "metadata" fields;
      extra = extra ["id"; "type"; "label"; "entityTypes"; "metadata"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_cancel_request = struct
  type t = { job_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      extra = extra ["jobId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_cancel_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; annotation_id : Yojson.Raw.t Types.presence; completed_units : Yojson.Raw.t Types.presence; unit_cursors : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      annotation_id = optional identity "annotationId" fields;
      completed_units = optional identity "completedUnits" fields;
      unit_cursors = optional identity "unitCursors" fields;
      extra = extra ["_userId"; "resourceId"; "jobId"; "jobType"; "annotationId"; "completedUnits"; "unitCursors"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_claim_command = struct
  type t = { accepts : Yojson.Raw.t; field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      accepts = required identity "accepts" fields;
      field_user_id = optional identity "_userId" fields;
      field_roles = optional identity "_roles" fields;
      extra = extra ["accepts"; "_userId"; "_roles"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_completed_payload = struct
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; total_steps : Yojson.Raw.t Types.presence; found_count : Yojson.Raw.t Types.presence; result_resource_id : Yojson.Raw.t Types.presence; annotation_uri : string Types.presence; result : Yojson.Raw.t Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      attempt = optional identity "attempt" fields;
      annotation_id = optional identity "annotationId" fields;
      total_steps = optional identity "totalSteps" fields;
      found_count = optional identity "foundCount" fields;
      result_resource_id = optional identity "resultResourceId" fields;
      annotation_uri = optional string "annotationUri" fields;
      result = optional identity "result" fields;
      durability = optional identity "durability" fields;
      extra = extra ["jobId"; "jobType"; "attempt"; "annotationId"; "totalSteps"; "foundCount"; "resultResourceId"; "annotationUri"; "result"; "durability"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_created_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_created_result_response = struct
  type t = { job_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      extra = extra ["jobId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_fail_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; error : string; completed_units : Yojson.Raw.t Types.presence; unit_cursors : Yojson.Raw.t Types.presence; failure_class : Yojson.Raw.t Types.presence; will_retry : bool Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      attempt = optional identity "attempt" fields;
      annotation_id = optional identity "annotationId" fields;
      error = required string "error" fields;
      completed_units = optional identity "completedUnits" fields;
      unit_cursors = optional identity "unitCursors" fields;
      failure_class = optional identity "failureClass" fields;
      will_retry = optional bool "willRetry" fields;
      durability = optional identity "durability" fields;
      extra = extra ["_userId"; "resourceId"; "jobId"; "jobType"; "attempt"; "annotationId"; "error"; "completedUnits"; "unitCursors"; "failureClass"; "willRetry"; "durability"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_checkpoint_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t; completed_units : Yojson.Raw.t; unit_cursors : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      job_id = required identity "jobId" fields;
      completed_units = required identity "completedUnits" fields;
      unit_cursors = optional identity "unitCursors" fields;
      extra = extra ["_userId"; "jobId"; "completedUnits"; "unitCursors"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Unit_cursor = struct
  type t = { next : Yojson.Raw.t; size : Yojson.Raw.t; found : Yojson.Raw.t; emitted : Yojson.Raw.t; errors : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      next = required identity "next" fields;
      size = required identity "size" fields;
      found = required identity "found" fields;
      emitted = required identity "emitted" fields;
      errors = required identity "errors" fields;
      extra = extra ["next"; "size"; "found"; "emitted"; "errors"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_declined = struct
  type t = { declined : bool; reason : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      declined = required bool "declined" fields;
      reason = required string "reason" fields;
      extra = extra ["declined"; "reason"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_failed_payload = struct
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; error : string; failure_class : Yojson.Raw.t Types.presence; will_retry : bool Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      attempt = optional identity "attempt" fields;
      annotation_id = optional identity "annotationId" fields;
      error = required string "error" fields;
      failure_class = optional identity "failureClass" fields;
      will_retry = optional bool "willRetry" fields;
      durability = optional identity "durability" fields;
      extra = extra ["jobId"; "jobType"; "attempt"; "annotationId"; "error"; "failureClass"; "willRetry"; "durability"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_job_done = struct
  type t = { resource_id : Yojson.Raw.t; resource_name : string; truncated : bool; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      resource_name = required string "resourceName" fields;
      truncated = required bool "truncated" fields;
      extra = extra ["resourceId"; "resourceName"; "truncated"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress = struct
  type t = { percentage : Yojson.Raw.t; message : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; current : Yojson.Raw.t Types.presence; processed : Yojson.Raw.t Types.presence; total : Yojson.Raw.t Types.presence; entities_found : Yojson.Raw.t Types.presence; entities_expected : Yojson.Raw.t Types.presence; entities_emitted : Yojson.Raw.t Types.presence; completed_items : Yojson.Raw.t Types.presence; request_params : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      percentage = required identity "percentage" fields;
      message = optional identity "message" fields;
      annotation_id = optional identity "annotationId" fields;
      current = optional identity "current" fields;
      processed = optional identity "processed" fields;
      total = optional identity "total" fields;
      entities_found = optional identity "entitiesFound" fields;
      entities_expected = optional identity "entitiesExpected" fields;
      entities_emitted = optional identity "entitiesEmitted" fields;
      completed_items = optional identity "completedItems" fields;
      request_params = optional identity "requestParams" fields;
      extra = extra ["percentage"; "message"; "annotationId"; "current"; "processed"; "total"; "entitiesFound"; "entitiesExpected"; "entitiesEmitted"; "completedItems"; "requestParams"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_analyzing = struct
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      extra = extra ["code"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_analyzing_tags = struct
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      extra = extra ["code"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_complete_created = struct
  type t = { code : string; count : Yojson.Raw.t; motivation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      count = required identity "count" fields;
      motivation = required identity "motivation" fields;
      extra = extra ["code"; "count"; "motivation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_complete_generated = struct
  type t = { code : string; truncated : bool; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      truncated = required bool "truncated" fields;
      extra = extra ["code"; "truncated"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_creating_annotations = struct
  type t = { code : string; count : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      count = required identity "count" fields;
      extra = extra ["code"; "count"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_creating_resource = struct
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      extra = extra ["code"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_creating_tag_annotations = struct
  type t = { code : string; count : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      count = required identity "count" fields;
      extra = extra ["code"; "count"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_detecting_entities = struct
  type t = { code : string; entity_type : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      entity_type = required string "entityType" fields;
      extra = extra ["code"; "entityType"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_generating_resource = struct
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      extra = extra ["code"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_progress_loading = struct
  type t = { code : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = required string "code" fields;
      extra = extra ["code"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_job_done = struct
  type t = { found : Yojson.Raw.t; persisted : Yojson.Raw.t; errors : Yojson.Raw.t Types.presence; by_category : Yojson.Raw.t Types.presence; under_reported_pieces : Yojson.Raw.t Types.presence; unchecked_pieces : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      found = required identity "found" fields;
      persisted = required identity "persisted" fields;
      errors = optional identity "errors" fields;
      by_category = optional identity "byCategory" fields;
      under_reported_pieces = optional identity "underReportedPieces" fields;
      unchecked_pieces = optional identity "uncheckedPieces" fields;
      extra = extra ["found"; "persisted"; "errors"; "byCategory"; "underReportedPieces"; "uncheckedPieces"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_report_progress_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; percentage : Yojson.Raw.t; progress : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      attempt = optional identity "attempt" fields;
      annotation_id = optional identity "annotationId" fields;
      percentage = required identity "percentage" fields;
      progress = optional identity "progress" fields;
      extra = extra ["_userId"; "resourceId"; "jobId"; "jobType"; "attempt"; "annotationId"; "percentage"; "progress"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_start_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; annotation_id : Yojson.Raw.t Types.presence; attempt : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      annotation_id = optional identity "annotationId" fields;
      attempt = optional identity "attempt" fields;
      extra = extra ["_userId"; "resourceId"; "jobId"; "jobType"; "annotationId"; "attempt"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_assign_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; resource_id : Yojson.Raw.t; holder : Yojson.Raw.t; requester : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      resource_id = required identity "resourceId" fields;
      holder = required identity "holder" fields;
      requester = required identity "requester" fields;
      extra = extra ["_userId"; "jobId"; "jobType"; "resourceId"; "holder"; "requester"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_started_payload = struct
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; annotation_id : Yojson.Raw.t Types.presence; total_steps : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      annotation_id = optional identity "annotationId" fields;
      total_steps = optional identity "totalSteps" fields;
      extra = extra ["jobId"; "jobType"; "annotationId"; "totalSteps"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_assigned_payload = struct
  type t = { job_id : Yojson.Raw.t; job_type : Yojson.Raw.t; resource_id : Yojson.Raw.t; holder : Yojson.Raw.t; requester : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      job_type = required identity "jobType" fields;
      resource_id = required identity "resourceId" fields;
      holder = required identity "holder" fields;
      requester = required identity "requester" fields;
      extra = extra ["jobId"; "jobType"; "resourceId"; "holder"; "requester"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Principal_profile_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; name : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      name = required string "name" fields;
      extra = extra ["_userId"; "name"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Principal_profiled_payload = struct
  type t = { name : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      extra = extra ["name"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_status_request = struct
  type t = { job_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      extra = extra ["jobId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_status_response = struct
  type t = { job_id : Yojson.Raw.t; type_ : Yojson.Raw.t; status : string; user_id : Yojson.Raw.t; created : string; started_at : string Types.presence; completed_at : string Types.presence; error : string Types.presence; failure_class : Yojson.Raw.t Types.presence; progress : Yojson.Raw.t Types.presence; result : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      type_ = required identity "type" fields;
      status = required string "status" fields;
      user_id = required identity "userId" fields;
      created = required string "created" fields;
      started_at = optional string "startedAt" fields;
      completed_at = optional string "completedAt" fields;
      error = optional string "error" fields;
      failure_class = optional identity "failureClass" fields;
      progress = optional identity "progress" fields;
      result = optional identity "result" fields;
      extra = extra ["jobId"; "type"; "status"; "userId"; "created"; "startedAt"; "completedAt"; "error"; "failureClass"; "progress"; "result"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_status_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Kb_description = struct
  type t = { name : string; domain : string; git_branch : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      domain = required string "domain" fields;
      git_branch = optional string "gitBranch" fields;
      extra = extra ["name"; "domain"; "gitBranch"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Http_endpoint = struct
  type t = { kind : string; host : string; port : Yojson.Raw.t; protocol : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kind = required string "kind" fields;
      host = required string "host" fields;
      port = required identity "port" fields;
      protocol = required string "protocol" fields;
      extra = extra ["kind"; "host"; "port"; "protocol"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Kb_read = struct
  type t = { at : string; git_branch : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      at = required string "at" fields;
      git_branch = optional string "gitBranch" fields;
      extra = extra ["at"; "gitBranch"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Kb_target = struct
  type t = { id : string; label : string; endpoint : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required string "id" fields;
      label = required string "label" fields;
      endpoint = required identity "endpoint" fields;
      extra = extra ["id"; "label"; "endpoint"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Knowledge_base = struct
  type t = { id : string; label : Yojson.Raw.t; endpoint : Yojson.Raw.t; did : string; last_read : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required string "id" fields;
      label = required identity "label" fields;
      endpoint = required identity "endpoint" fields;
      did = required string "did" fields;
      last_read = optional identity "lastRead" fields;
      extra = extra ["id"; "label"; "endpoint"; "did"; "lastRead"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Local_endpoint = struct
  type t = { kind : string; kb_id : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kind = required string "kind" fields;
      kb_id = required string "kbId" fields;
      extra = extra ["kind"; "kbId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module New_knowledge_base = struct
  type t = { label : string; endpoint : Yojson.Raw.t; did : string; last_read : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      label = required string "label" fields;
      endpoint = required identity "endpoint" fields;
      did = required string "did" fields;
      last_read = optional identity "lastRead" fields;
      extra = extra ["label"; "endpoint"; "did"; "lastRead"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Knowledge_graph = struct
  type t = { nodes : Yojson.Raw.t; edges : Yojson.Raw.t; truncated : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      nodes = required identity "nodes" fields;
      edges = required identity "edges" fields;
      truncated = optional bool "truncated" fields;
      extra = extra ["nodes"; "edges"; "truncated"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module List_resources_response = struct
  type t = { resources : Yojson.Raw.t; total : Yojson.Raw.t; offset : Yojson.Raw.t; limit : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resources = required identity "resources" fields;
      total = required identity "total" fields;
      offset = required identity "offset" fields;
      limit = required identity "limit" fields;
      extra = extra ["resources"; "total"; "offset"; "limit"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_archive_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; storage_uri : string Types.presence; keep_file : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      storage_uri = optional string "storageUri" fields;
      keep_file = optional bool "keepFile" fields;
      extra = extra ["_userId"; "resourceId"; "storageUri"; "keepFile"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_create_ok = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_create_ok_response = struct
  type t = { annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      annotation_id = required identity "annotationId" fields;
      extra = extra ["annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_commit_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; annotations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      field_roles = optional identity "_roles" fields;
      job_id = optional identity "jobId" fields;
      resource_id = required identity "resourceId" fields;
      annotations = required identity "annotations" fields;
      extra = extra ["_userId"; "_roles"; "jobId"; "resourceId"; "annotations"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_commit_ok = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_create_request = struct
  type t = { resource_id : Yojson.Raw.t; request : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      request = required identity "request" fields;
      extra = extra ["resourceId"; "request"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_delete_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      annotation_id = required identity "annotationId" fields;
      resource_id = optional identity "resourceId" fields;
      extra = extra ["_userId"; "annotationId"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_delete_ok = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_requested_event = struct
  type t = { source : Yojson.Raw.t; selector : Yojson.Raw.t; motivation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      source = required identity "source" fields;
      selector = required identity "selector" fields;
      motivation = required identity "motivation" fields;
      extra = extra ["source"; "selector"; "motivation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_submit_event = struct
  type t = { source : Yojson.Raw.t; motivation : Yojson.Raw.t; selector : Yojson.Raw.t; body : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      source = required identity "source" fields;
      motivation = required identity "motivation" fields;
      selector = required identity "selector" fields;
      body = optional identity "body" fields;
      extra = extra ["source"; "motivation"; "selector"; "body"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_unarchive_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; storage_uri : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      storage_uri = optional string "storageUri" fields;
      extra = extra ["_userId"; "resourceId"; "storageUri"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_update_body_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t; resource_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      annotation_id = required identity "annotationId" fields;
      resource_id = required identity "resourceId" fields;
      operations = required identity "operations" fields;
      extra = extra ["_userId"; "annotationId"; "resourceId"; "operations"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_update_entity_types_command = struct
  type t = { resource_id : Yojson.Raw.t; field_user_id : Yojson.Raw.t Types.presence; current_entity_types : Yojson.Raw.t; updated_entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      field_user_id = optional identity "_userId" fields;
      current_entity_types = required identity "currentEntityTypes" fields;
      updated_entity_types = required identity "updatedEntityTypes" fields;
      extra = extra ["resourceId"; "_userId"; "currentEntityTypes"; "updatedEntityTypes"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Match_search_failed = struct
  type t = { reference_id : Yojson.Raw.t; error : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      reference_id = required identity "referenceId" fields;
      error = required string "error" fields;
      extra = extra ["referenceId"; "error"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Match_search_request = struct
  type t = { resource_id : Yojson.Raw.t; reference_id : Yojson.Raw.t; context : Yojson.Raw.t; limit : Yojson.Raw.t Types.presence; use_semantic_scoring : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      reference_id = required identity "referenceId" fields;
      context = required identity "context" fields;
      limit = optional identity "limit" fields;
      use_semantic_scoring = optional bool "useSemanticScoring" fields;
      extra = extra ["resourceId"; "referenceId"; "context"; "limit"; "useSemanticScoring"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Match_search_result = struct
  type t = { reference_id : Yojson.Raw.t; response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      reference_id = required identity "referenceId" fields;
      response = required identity "response" fields;
      extra = extra ["referenceId"; "response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Match_resources_request = struct
  type t = { search : string; archived : bool Types.presence; entity_type : string Types.presence; offset : Yojson.Raw.t Types.presence; limit : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      search = required string "search" fields;
      archived = optional bool "archived" fields;
      entity_type = optional string "entityType" fields;
      offset = optional identity "offset" fields;
      limit = optional identity "limit" fields;
      extra = extra ["search"; "archived"; "entityType"; "offset"; "limit"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Match_resources_response = struct
  type t = { resources : Yojson.Raw.t; total : Yojson.Raw.t; offset : Yojson.Raw.t; limit : Yojson.Raw.t; match_kind : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resources = required identity "resources" fields;
      total = required identity "total" fields;
      offset = required identity "offset" fields;
      limit = required identity "limit" fields;
      match_kind = required string "matchKind" fields;
      extra = extra ["resources"; "total"; "offset"; "limit"; "matchKind"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Match_resources_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Media_token_request = struct
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      extra = extra ["resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Media_token_response = struct
  type t = { token : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      token = required string "token" fields;
      extra = extra ["token"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Protected_resource_metadata = struct
  type t = { resource : string; authorization_servers : Yojson.Raw.t; bearer_methods_supported : Yojson.Raw.t; resource_name : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource = required string "resource" fields;
      authorization_servers = required identity "authorization_servers" fields;
      bearer_methods_supported = required identity "bearer_methods_supported" fields;
      resource_name = optional string "resource_name" fields;
      extra = extra ["resource"; "authorization_servers"; "bearer_methods_supported"; "resource_name"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Representation = struct
  type t = { field_id : string Types.presence; field_type : Yojson.Raw.t Types.presence; media_type : string; storage_uri : string Types.presence; filename : string Types.presence; byte_size : Yojson.Raw.t Types.presence; checksum : string Types.presence; encoding : string Types.presence; language : string Types.presence; width : Yojson.Raw.t Types.presence; height : Yojson.Raw.t Types.presence; duration : Yojson.Raw.t Types.presence; created : string Types.presence; modified : string Types.presence; conforms_to : Yojson.Raw.t Types.presence; tags : Yojson.Raw.t Types.presence; rel : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_id = optional string "@id" fields;
      field_type = optional identity "@type" fields;
      media_type = required string "mediaType" fields;
      storage_uri = optional string "storageUri" fields;
      filename = optional string "filename" fields;
      byte_size = optional identity "byteSize" fields;
      checksum = optional string "checksum" fields;
      encoding = optional string "encoding" fields;
      language = optional string "language" fields;
      width = optional identity "width" fields;
      height = optional identity "height" fields;
      duration = optional identity "duration" fields;
      created = optional string "created" fields;
      modified = optional string "modified" fields;
      conforms_to = optional identity "conformsTo" fields;
      tags = optional identity "tags" fields;
      rel = optional string "rel" fields;
      extra = extra ["@id"; "@type"; "mediaType"; "storageUri"; "filename"; "byteSize"; "checksum"; "encoding"; "language"; "width"; "height"; "duration"; "created"; "modified"; "conformsTo"; "tags"; "rel"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Representation_added_payload = struct
  type t = { representation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      representation = required identity "representation" fields;
      extra = extra ["representation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Representation_removed_payload = struct
  type t = { checksum : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      checksum = required string "checksum" fields;
      extra = extra ["checksum"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_archived_payload = struct
  type t = { reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      reason = optional string "reason" fields;
      extra = extra ["reason"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_cloned_payload = struct
  type t = { name : string; format : Yojson.Raw.t; content_checksum : string; content_byte_size : Yojson.Raw.t Types.presence; storage_uri : string Types.presence; parent_resource_id : Yojson.Raw.t; entity_types : Yojson.Raw.t Types.presence; language : string Types.presence; creator : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      format = required identity "format" fields;
      content_checksum = required string "contentChecksum" fields;
      content_byte_size = optional identity "contentByteSize" fields;
      storage_uri = optional string "storageUri" fields;
      parent_resource_id = required identity "parentResourceId" fields;
      entity_types = optional identity "entityTypes" fields;
      language = optional string "language" fields;
      creator = optional identity "creator" fields;
      was_attributed_to = optional identity "wasAttributedTo" fields;
      extra = extra ["name"; "format"; "contentChecksum"; "contentByteSize"; "storageUri"; "parentResourceId"; "entityTypes"; "language"; "creator"; "wasAttributedTo"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_created_payload = struct
  type t = { name : string; format : Yojson.Raw.t; content_checksum : string; content_byte_size : Yojson.Raw.t Types.presence; entity_types : Yojson.Raw.t Types.presence; storage_uri : string Types.presence; language : string Types.presence; is_draft : bool Types.presence; job_id : Yojson.Raw.t Types.presence; generated_from : Yojson.Raw.t Types.presence; generation_prompt : string Types.presence; generator : Yojson.Raw.t Types.presence; creator : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      format = required identity "format" fields;
      content_checksum = required string "contentChecksum" fields;
      content_byte_size = optional identity "contentByteSize" fields;
      entity_types = optional identity "entityTypes" fields;
      storage_uri = optional string "storageUri" fields;
      language = optional string "language" fields;
      is_draft = optional bool "isDraft" fields;
      job_id = optional identity "jobId" fields;
      generated_from = optional identity "generatedFrom" fields;
      generation_prompt = optional string "generationPrompt" fields;
      generator = optional identity "generator" fields;
      creator = optional identity "creator" fields;
      was_attributed_to = optional identity "wasAttributedTo" fields;
      extra = extra ["name"; "format"; "contentChecksum"; "contentByteSize"; "entityTypes"; "storageUri"; "language"; "isDraft"; "jobId"; "generatedFrom"; "generationPrompt"; "generator"; "creator"; "wasAttributedTo"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_descriptor = struct
  type t = { field_context : Yojson.Raw.t; field_id : Yojson.Raw.t; field_type : Yojson.Raw.t Types.presence; name : string; description : string Types.presence; identifier : Yojson.Raw.t Types.presence; about : Yojson.Raw.t Types.presence; same_as : Yojson.Raw.t Types.presence; is_part_of : Yojson.Raw.t Types.presence; has_part : Yojson.Raw.t Types.presence; license : string Types.presence; version : string Types.presence; date_created : string Types.presence; date_modified : string Types.presence; was_derived_from : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; generator : Yojson.Raw.t Types.presence; conforms_to : Yojson.Raw.t Types.presence; available_formats : Yojson.Raw.t Types.presence; representations : Yojson.Raw.t; archived : bool Types.presence; entity_types : Yojson.Raw.t Types.presence; is_draft : bool Types.presence; source_annotation_id : Yojson.Raw.t Types.presence; source_resource_id : Yojson.Raw.t Types.presence; originated_from : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_context = required identity "@context" fields;
      field_id = required identity "@id" fields;
      field_type = optional identity "@type" fields;
      name = required string "name" fields;
      description = optional string "description" fields;
      identifier = optional identity "identifier" fields;
      about = optional identity "about" fields;
      same_as = optional identity "sameAs" fields;
      is_part_of = optional identity "isPartOf" fields;
      has_part = optional identity "hasPart" fields;
      license = optional string "license" fields;
      version = optional string "version" fields;
      date_created = optional string "dateCreated" fields;
      date_modified = optional string "dateModified" fields;
      was_derived_from = optional identity "wasDerivedFrom" fields;
      was_attributed_to = optional identity "wasAttributedTo" fields;
      generator = optional identity "generator" fields;
      conforms_to = optional identity "conformsTo" fields;
      available_formats = optional identity "availableFormats" fields;
      representations = required identity "representations" fields;
      archived = optional bool "archived" fields;
      entity_types = optional identity "entityTypes" fields;
      is_draft = optional bool "isDraft" fields;
      source_annotation_id = optional identity "sourceAnnotationId" fields;
      source_resource_id = optional identity "sourceResourceId" fields;
      originated_from = optional string "originatedFrom" fields;
      extra = extra ["@context"; "@id"; "@type"; "name"; "description"; "identifier"; "about"; "sameAs"; "isPartOf"; "hasPart"; "license"; "version"; "dateCreated"; "dateModified"; "wasDerivedFrom"; "wasAttributedTo"; "generator"; "conformsTo"; "availableFormats"; "representations"; "archived"; "entityTypes"; "isDraft"; "sourceAnnotationId"; "sourceResourceId"; "originatedFrom"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_moved_payload = struct
  type t = { from_uri : string; to_uri : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      from_uri = required string "fromUri" fields;
      to_uri = required string "toUri" fields;
      extra = extra ["fromUri"; "toUri"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_updated_payload = struct
  type t = { content_checksum : string; content_byte_size : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      content_checksum = required string "contentChecksum" fields;
      content_byte_size = optional identity "contentByteSize" fields;
      extra = extra ["contentChecksum"; "contentByteSize"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Scored_resource = struct
  type t = { field_context : Yojson.Raw.t; field_id : Yojson.Raw.t; field_type : Yojson.Raw.t Types.presence; name : string; description : string Types.presence; identifier : Yojson.Raw.t Types.presence; about : Yojson.Raw.t Types.presence; same_as : Yojson.Raw.t Types.presence; is_part_of : Yojson.Raw.t Types.presence; has_part : Yojson.Raw.t Types.presence; license : string Types.presence; version : string Types.presence; date_created : string Types.presence; date_modified : string Types.presence; was_derived_from : Yojson.Raw.t Types.presence; was_attributed_to : Yojson.Raw.t Types.presence; generator : Yojson.Raw.t Types.presence; conforms_to : Yojson.Raw.t Types.presence; available_formats : Yojson.Raw.t Types.presence; representations : Yojson.Raw.t; archived : bool Types.presence; entity_types : Yojson.Raw.t Types.presence; is_draft : bool Types.presence; source_annotation_id : Yojson.Raw.t Types.presence; source_resource_id : Yojson.Raw.t Types.presence; originated_from : string Types.presence; score : Yojson.Raw.t Types.presence; match_reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_context = required identity "@context" fields;
      field_id = required identity "@id" fields;
      field_type = optional identity "@type" fields;
      name = required string "name" fields;
      description = optional string "description" fields;
      identifier = optional identity "identifier" fields;
      about = optional identity "about" fields;
      same_as = optional identity "sameAs" fields;
      is_part_of = optional identity "isPartOf" fields;
      has_part = optional identity "hasPart" fields;
      license = optional string "license" fields;
      version = optional string "version" fields;
      date_created = optional string "dateCreated" fields;
      date_modified = optional string "dateModified" fields;
      was_derived_from = optional identity "wasDerivedFrom" fields;
      was_attributed_to = optional identity "wasAttributedTo" fields;
      generator = optional identity "generator" fields;
      conforms_to = optional identity "conformsTo" fields;
      available_formats = optional identity "availableFormats" fields;
      representations = required identity "representations" fields;
      archived = optional bool "archived" fields;
      entity_types = optional identity "entityTypes" fields;
      is_draft = optional bool "isDraft" fields;
      source_annotation_id = optional identity "sourceAnnotationId" fields;
      source_resource_id = optional identity "sourceResourceId" fields;
      originated_from = optional string "originatedFrom" fields;
      score = optional identity "score" fields;
      match_reason = optional string "matchReason" fields;
      extra = extra ["@context"; "@id"; "@type"; "name"; "description"; "identifier"; "about"; "sameAs"; "isPartOf"; "hasPart"; "license"; "version"; "dateCreated"; "dateModified"; "wasDerivedFrom"; "wasAttributedTo"; "generator"; "conformsTo"; "availableFormats"; "representations"; "archived"; "entityTypes"; "isDraft"; "sourceAnnotationId"; "sourceResourceId"; "originatedFrom"; "score"; "matchReason"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Semantic_match = struct
  type t = { text : string; resource_id : Yojson.Raw.t; resource_name : string; annotation_id : Yojson.Raw.t Types.presence; score : Yojson.Raw.t; entity_types : Yojson.Raw.t Types.presence; machine_read : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      text = required string "text" fields;
      resource_id = required identity "resourceId" fields;
      resource_name = required string "resourceName" fields;
      annotation_id = optional identity "annotationId" fields;
      score = required identity "score" fields;
      entity_types = optional identity "entityTypes" fields;
      machine_read = optional bool "machineRead" fields;
      extra = extra ["text"; "resourceId"; "resourceName"; "annotationId"; "score"; "entityTypes"; "machineRead"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Session_joined_event = struct
  type t = { participant : Yojson.Raw.t; connection_id : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      participant = required identity "participant" fields;
      connection_id = required string "connectionId" fields;
      extra = extra ["participant"; "connectionId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Session_left_event = struct
  type t = { participant : Yojson.Raw.t; connection_id : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      participant = required identity "participant" fields;
      connection_id = required string "connectionId" fields;
      extra = extra ["participant"; "connectionId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Settings_hover_delay_changed_event = struct
  type t = { hover_delay_ms : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      hover_delay_ms = required identity "hoverDelayMs" fields;
      extra = extra ["hoverDelayMs"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Settings_locale_changed_event = struct
  type t = { locale : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      locale = required string "locale" fields;
      extra = extra ["locale"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Settings_theme_changed_event = struct
  type t = { theme : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      theme = required string "theme" fields;
      extra = extra ["theme"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Specific_resource = struct
  type t = { type_ : string; source : Yojson.Raw.t; purpose : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      source = required identity "source" fields;
      purpose = optional identity "purpose" fields;
      extra = extra ["type"; "source"; "purpose"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Status_response = struct
  type t = { status : string; version : string; features : Yojson.Raw.t; message : string; authenticated_as : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      version = required string "version" fields;
      features = required identity "features" fields;
      message = required string "message" fields;
      authenticated_as = optional string "authenticatedAs" fields;
      extra = extra ["status"; "version"; "features"; "message"; "authenticatedAs"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Stored_event_response = struct
  type t = { id : string; type_ : string; timestamp : string; user_id : Yojson.Raw.t; resource_id : Yojson.Raw.t Types.presence; version : Yojson.Raw.t; payload : Yojson.Raw.t; metadata : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required string "id" fields;
      type_ = required string "type" fields;
      timestamp = required string "timestamp" fields;
      user_id = required identity "userId" fields;
      resource_id = optional identity "resourceId" fields;
      version = required identity "version" fields;
      payload = required identity "payload" fields;
      metadata = required identity "metadata" fields;
      extra = extra ["id"; "type"; "timestamp"; "userId"; "resourceId"; "version"; "payload"; "metadata"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Svg_selector = struct
  type t = { type_ : string; value : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      value = required string "value" fields;
      extra = extra ["type"; "value"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Tag_category = struct
  type t = { name : string; description : string; examples : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      description = required string "description" fields;
      examples = required identity "examples" fields;
      extra = extra ["name"; "description"; "examples"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Tag_schema = struct
  type t = { id : string; name : string; description : string; domain : string; tags : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required string "id" fields;
      name = required string "name" fields;
      description = required string "description" fields;
      domain = required string "domain" fields;
      tags = required identity "tags" fields;
      extra = extra ["id"; "name"; "description"; "domain"; "tags"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Tag_schema_added_payload = struct
  type t = { schema : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      schema = required identity "schema" fields;
      extra = extra ["schema"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Text_position_selector = struct
  type t = { type_ : string; start : Yojson.Raw.t; end_ : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      start = required identity "start" fields;
      end_ = required identity "end" fields;
      extra = extra ["type"; "start"; "end"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Text_quote_selector = struct
  type t = { type_ : string; exact : string; prefix : string Types.presence; suffix : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      exact = required string "exact" fields;
      prefix = optional string "prefix" fields;
      suffix = optional string "suffix" fields;
      extra = extra ["type"; "exact"; "prefix"; "suffix"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Textual_body = struct
  type t = { type_ : string; value : string; purpose : Yojson.Raw.t Types.presence; format : string Types.presence; language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      value = required string "value" fields;
      purpose = optional identity "purpose" fields;
      format = optional string "format" fields;
      language = optional string "language" fields;
      extra = extra ["type"; "value"; "purpose"; "format"; "language"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Update_annotation_body_request = struct
  type t = { resource_id : Yojson.Raw.t; operations : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      operations = required identity "operations" fields;
      extra = extra ["resourceId"; "operations"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module User_response = struct
  type t = { did : Yojson.Raw.t; email : Yojson.Raw.t; name : Yojson.Raw.t; image : Yojson.Raw.t; domain : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      did = required identity "did" fields;
      email = required identity "email" fields;
      name = required identity "name" fields;
      image = required identity "image" fields;
      domain = required string "domain" fields;
      extra = extra ["did"; "email"; "name"; "image"; "domain"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Smelt_rebuild_anchors_command = struct
  type t = { resource_id : Yojson.Raw.t Types.presence; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = optional identity "resourceId" fields;
      field_user_id = optional identity "_userId" fields;
      extra = extra ["resourceId"; "_userId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Weave_rebuild_command = struct
  type t = { resource_id : Yojson.Raw.t Types.presence; field_user_id : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = optional identity "resourceId" fields;
      field_user_id = optional identity "_userId" fields;
      extra = extra ["resourceId"; "_userId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_clone_create_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; token : string; name : string; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; format : Yojson.Raw.t; archive_original : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      token = required string "token" fields;
      name = required string "name" fields;
      storage_uri = required string "storageUri" fields;
      content_checksum = required string "contentChecksum" fields;
      byte_size = required identity "byteSize" fields;
      format = required identity "format" fields;
      archive_original = optional bool "archiveOriginal" fields;
      extra = extra ["_userId"; "token"; "name"; "storageUri"; "contentChecksum"; "byteSize"; "format"; "archiveOriginal"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_clone_created = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_clone_resource_request = struct
  type t = { token : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      token = required string "token" fields;
      extra = extra ["token"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_clone_token_request = struct
  type t = { resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      extra = extra ["resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_create_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_id : Yojson.Raw.t Types.presence; name : string; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; format : Yojson.Raw.t; language : string Types.presence; entity_types : Yojson.Raw.t Types.presence; is_draft : bool Types.presence; generated_from : Yojson.Raw.t Types.presence; generation_prompt : string Types.presence; generator : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      field_roles = optional identity "_roles" fields;
      job_id = optional identity "jobId" fields;
      name = required string "name" fields;
      storage_uri = required string "storageUri" fields;
      content_checksum = required string "contentChecksum" fields;
      byte_size = required identity "byteSize" fields;
      format = required identity "format" fields;
      language = optional string "language" fields;
      entity_types = optional identity "entityTypes" fields;
      is_draft = optional bool "isDraft" fields;
      generated_from = optional identity "generatedFrom" fields;
      generation_prompt = optional string "generationPrompt" fields;
      generator = optional identity "generator" fields;
      extra = extra ["_userId"; "_roles"; "jobId"; "name"; "storageUri"; "contentChecksum"; "byteSize"; "format"; "language"; "entityTypes"; "isDraft"; "generatedFrom"; "generationPrompt"; "generator"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_clone_persist_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; name : string; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; format : Yojson.Raw.t; language : string Types.presence; entity_types : Yojson.Raw.t Types.presence; parent_resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      name = required string "name" fields;
      storage_uri = required string "storageUri" fields;
      content_checksum = required string "contentChecksum" fields;
      byte_size = required identity "byteSize" fields;
      format = required identity "format" fields;
      language = optional string "language" fields;
      entity_types = optional identity "entityTypes" fields;
      parent_resource_id = required identity "parentResourceId" fields;
      extra = extra ["_userId"; "name"; "storageUri"; "contentChecksum"; "byteSize"; "format"; "language"; "entityTypes"; "parentResourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_create_ok = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_clone_persist_ok = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_update_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; storage_uri : string; content_checksum : string; byte_size : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      storage_uri = required string "storageUri" fields;
      content_checksum = required string "contentChecksum" fields;
      byte_size = required identity "byteSize" fields;
      extra = extra ["_userId"; "resourceId"; "storageUri"; "contentChecksum"; "byteSize"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_update_ok = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bus_event_message = struct
  type t = { event : string; id : Yojson.Raw.t; data : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      event = required string "event" fields;
      id = required identity "id" fields;
      data = required identity "data" fields;
      extra = extra ["event"; "id"; "data"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bus_frame = struct
  type t = { channel : string; correlation_id : string Types.presence; payload : Yojson.Raw.t; scope : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      channel = required string "channel" fields;
      correlation_id = optional string "correlationId" fields;
      payload = required identity "payload" fields;
      scope = optional identity "scope" fields;
      extra = extra ["channel"; "correlationId"; "payload"; "scope"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bus_ping_message = struct
  type t = { event : string; data : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      event = required string "event" fields;
      data = required string "data" fields;
      extra = extra ["event"; "data"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Bus_resume_gap = struct
  type t = { scope : Yojson.Raw.t; last_seen_id : string; reason : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      scope = required identity "scope" fields;
      last_seen_id = required string "lastSeenId" fields;
      reason = required string "reason" fields;
      extra = extra ["scope"; "lastSeenId"; "reason"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gateway_config = struct
  type t = { kb : Yojson.Raw.t; port : Yojson.Raw.t; public_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; signal : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; capacity : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kb = required identity "kb" fields;
      port = required identity "port" fields;
      public_url = required string "publicUrl" fields;
      identity = required identity "identity" fields;
      archivist = required identity "archivist" fields;
      signal = required identity "signal" fields;
      log_level = required identity "logLevel" fields;
      log_format = required identity "logFormat" fields;
      capacity = required identity "capacity" fields;
      extra = extra ["kb"; "port"; "publicUrl"; "identity"; "archivist"; "signal"; "logLevel"; "logFormat"; "capacity"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Kb_identity = struct
  type t = { name : string; domain : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      domain = required string "domain" fields;
      extra = extra ["name"; "domain"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_upload = struct
  type t = { name : string; file : string; format : string; storage_uri : string; language : string Types.presence; entity_types : string Types.presence; source_annotation_id : Yojson.Raw.t Types.presence; source_resource_id : Yojson.Raw.t Types.presence; generation_prompt : string Types.presence; generator : string Types.presence; job_id : Yojson.Raw.t Types.presence; is_draft : string Types.presence; clone_token : string Types.presence; archive_original : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      file = required string "file" fields;
      format = required string "format" fields;
      storage_uri = required string "storageUri" fields;
      language = optional string "language" fields;
      entity_types = optional string "entityTypes" fields;
      source_annotation_id = optional identity "sourceAnnotationId" fields;
      source_resource_id = optional identity "sourceResourceId" fields;
      generation_prompt = optional string "generationPrompt" fields;
      generator = optional string "generator" fields;
      job_id = optional identity "jobId" fields;
      is_draft = optional string "isDraft" fields;
      clone_token = optional string "cloneToken" fields;
      archive_original = optional string "archiveOriginal" fields;
      extra = extra ["name"; "file"; "format"; "storageUri"; "language"; "entityTypes"; "sourceAnnotationId"; "sourceResourceId"; "generationPrompt"; "generator"; "jobId"; "isDraft"; "cloneToken"; "archiveOriginal"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Archivist_events_response = struct
  type t = { events : Yojson.Raw.t; last_sequence : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      events = required identity "events" fields;
      last_sequence = required identity "lastSequence" fields;
      extra = extra ["events"; "lastSequence"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Archivist_stream = struct
  type t = { resource_id : Yojson.Raw.t; last_sequence : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      last_sequence = required identity "lastSequence" fields;
      extra = extra ["resourceId"; "lastSequence"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Archivist_streams_response = struct
  type t = { streams : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      streams = required identity "streams" fields;
      extra = extra ["streams"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Archivist_health = struct
  type t = { status : string; actors : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      actors = required identity "actors" fields;
      extra = extra ["status"; "actors"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Representation_not_found = struct
  type t = { error : string; code : Yojson.Raw.t; hint : string Types.presence; details : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      error = required string "error" fields;
      code = required identity "code" fields;
      hint = optional string "hint" fields;
      details = optional identity "details" fields;
      extra = extra ["error"; "code"; "hint"; "details"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Limit_refusal = struct
  type t = { error : string; code : Yojson.Raw.t; hint : string Types.presence; details : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      error = required string "error" fields;
      code = required identity "code" fields;
      hint = optional string "hint" fields;
      details = optional identity "details" fields;
      extra = extra ["error"; "code"; "hint"; "details"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_metadata = struct
  type t = { id : Yojson.Raw.t; type_ : Yojson.Raw.t; user_id : Yojson.Raw.t; created : string; retry_count : Yojson.Raw.t; max_retries : Yojson.Raw.t; completed_units : Yojson.Raw.t Types.presence; unit_cursors : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      id = required identity "id" fields;
      type_ = required identity "type" fields;
      user_id = required identity "userId" fields;
      created = required string "created" fields;
      retry_count = required identity "retryCount" fields;
      max_retries = required identity "maxRetries" fields;
      completed_units = optional identity "completedUnits" fields;
      unit_cursors = optional identity "unitCursors" fields;
      extra = extra ["id"; "type"; "userId"; "created"; "retryCount"; "maxRetries"; "completedUnits"; "unitCursors"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_params = struct
  type t = { resource_id : Yojson.Raw.t; schema : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      schema = optional identity "schema" fields;
      extra = extra ["resourceId"; "schema"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Highlighting_job_params = struct
  type t = { motivation : string; instructions : string Types.presence; density : Yojson.Raw.t Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      motivation = required string "motivation" fields;
      instructions = optional string "instructions" fields;
      density = optional identity "density" fields;
      source_language = optional string "sourceLanguage" fields;
      extra = extra ["motivation"; "instructions"; "density"; "sourceLanguage"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Commenting_job_params = struct
  type t = { motivation : string; instructions : string Types.presence; tone : string Types.presence; density : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      motivation = required string "motivation" fields;
      instructions = optional string "instructions" fields;
      tone = optional string "tone" fields;
      density = optional identity "density" fields;
      language = optional string "language" fields;
      source_language = optional string "sourceLanguage" fields;
      extra = extra ["motivation"; "instructions"; "tone"; "density"; "language"; "sourceLanguage"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Assessing_job_params = struct
  type t = { motivation : string; instructions : string Types.presence; tone : string Types.presence; density : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      motivation = required string "motivation" fields;
      instructions = optional string "instructions" fields;
      tone = optional string "tone" fields;
      density = optional identity "density" fields;
      language = optional string "language" fields;
      source_language = optional string "sourceLanguage" fields;
      extra = extra ["motivation"; "instructions"; "tone"; "density"; "language"; "sourceLanguage"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Linking_job_params = struct
  type t = { motivation : string; entity_types : Yojson.Raw.t; include_descriptive_references : bool Types.presence; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      motivation = required string "motivation" fields;
      entity_types = required identity "entityTypes" fields;
      include_descriptive_references = optional bool "includeDescriptiveReferences" fields;
      language = optional string "language" fields;
      source_language = optional string "sourceLanguage" fields;
      extra = extra ["motivation"; "entityTypes"; "includeDescriptiveReferences"; "language"; "sourceLanguage"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Tagging_job_params = struct
  type t = { motivation : string; schema_id : string; categories : Yojson.Raw.t; language : string Types.presence; source_language : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      motivation = required string "motivation" fields;
      schema_id = required string "schemaId" fields;
      categories = required identity "categories" fields;
      language = optional string "language" fields;
      source_language = optional string "sourceLanguage" fields;
      extra = extra ["motivation"; "schemaId"; "categories"; "language"; "sourceLanguage"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Generation_job_request = struct
  type t = { title : string; storage_uri : string; prompt : string Types.presence; entity_types : Yojson.Raw.t Types.presence; language : string Types.presence; source_language : string Types.presence; temperature : Yojson.Raw.t Types.presence; max_tokens : Yojson.Raw.t Types.presence; output_media_type : Yojson.Raw.t Types.presence; task : string Types.presence; structure : string Types.presence; cite : bool Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      title = required string "title" fields;
      storage_uri = required string "storageUri" fields;
      prompt = optional string "prompt" fields;
      entity_types = optional identity "entityTypes" fields;
      language = optional string "language" fields;
      source_language = optional string "sourceLanguage" fields;
      temperature = optional identity "temperature" fields;
      max_tokens = optional identity "maxTokens" fields;
      output_media_type = optional identity "outputMediaType" fields;
      task = optional string "task" fields;
      structure = optional string "structure" fields;
      cite = optional bool "cite" fields;
      extra = extra ["title"; "storageUri"; "prompt"; "entityTypes"; "language"; "sourceLanguage"; "temperature"; "maxTokens"; "outputMediaType"; "task"; "structure"; "cite"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_job_create_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_type : string; resource_id : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      field_roles = optional identity "_roles" fields;
      job_type = required string "jobType" fields;
      resource_id = required identity "resourceId" fields;
      params = required identity "params" fields;
      extra = extra ["_userId"; "_roles"; "jobType"; "resourceId"; "params"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_job_create_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; field_roles : Yojson.Raw.t Types.presence; job_type : string; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      field_roles = optional identity "_roles" fields;
      job_type = required string "jobType" fields;
      params = required identity "params" fields;
      extra = extra ["_userId"; "_roles"; "jobType"; "params"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_job_queued_event = struct
  type t = { job_id : Yojson.Raw.t; job_type : string; resource_id : Yojson.Raw.t; user_id : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      job_type = required string "jobType" fields;
      resource_id = required identity "resourceId" fields;
      user_id = required identity "userId" fields;
      params = required identity "params" fields;
      extra = extra ["jobId"; "jobType"; "resourceId"; "userId"; "params"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_job_queued_event = struct
  type t = { job_id : Yojson.Raw.t; job_type : string; resource_id : Yojson.Raw.t; user_id : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_id = required identity "jobId" fields;
      job_type = required string "jobType" fields;
      resource_id = required identity "resourceId" fields;
      user_id = required identity "userId" fields;
      params = required identity "params" fields;
      extra = extra ["jobId"; "jobType"; "resourceId"; "userId"; "params"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_job_complete_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : string; attempt : Yojson.Raw.t Types.presence; result : Yojson.Raw.t Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      job_id = required identity "jobId" fields;
      job_type = required string "jobType" fields;
      attempt = optional identity "attempt" fields;
      result = optional identity "result" fields;
      durability = optional identity "durability" fields;
      extra = extra ["_userId"; "resourceId"; "jobId"; "jobType"; "attempt"; "result"; "durability"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_job_complete_command = struct
  type t = { field_user_id : Yojson.Raw.t Types.presence; resource_id : Yojson.Raw.t; job_id : Yojson.Raw.t; job_type : string; attempt : Yojson.Raw.t Types.presence; annotation_id : Yojson.Raw.t Types.presence; result : Yojson.Raw.t Types.presence; durability : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      field_user_id = optional identity "_userId" fields;
      resource_id = required identity "resourceId" fields;
      job_id = required identity "jobId" fields;
      job_type = required string "jobType" fields;
      attempt = optional identity "attempt" fields;
      annotation_id = optional identity "annotationId" fields;
      result = optional identity "result" fields;
      durability = optional identity "durability" fields;
      extra = extra ["_userId"; "resourceId"; "jobId"; "jobType"; "attempt"; "annotationId"; "result"; "durability"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_job_filter = struct
  type t = { job_type : string; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_type = required string "jobType" fields;
      params = required identity "params" fields;
      extra = extra ["jobType"; "params"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Yield_job_filter = struct
  type t = { job_type : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job_type = required string "jobType" fields;
      extra = extra ["jobType"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_pending = struct
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      metadata = required identity "metadata" fields;
      params = required identity "params" fields;
      extra = extra ["status"; "metadata"; "params"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_running = struct
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string; progress : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      metadata = required identity "metadata" fields;
      params = required identity "params" fields;
      started_at = required string "startedAt" fields;
      progress = required identity "progress" fields;
      extra = extra ["status"; "metadata"; "params"; "startedAt"; "progress"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_complete = struct
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string; completed_at : string; result : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      metadata = required identity "metadata" fields;
      params = required identity "params" fields;
      started_at = required string "startedAt" fields;
      completed_at = required string "completedAt" fields;
      result = required identity "result" fields;
      extra = extra ["status"; "metadata"; "params"; "startedAt"; "completedAt"; "result"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_failed = struct
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string Types.presence; completed_at : string; error : string; failure_class : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      metadata = required identity "metadata" fields;
      params = required identity "params" fields;
      started_at = optional string "startedAt" fields;
      completed_at = required string "completedAt" fields;
      error = required string "error" fields;
      failure_class = optional identity "failureClass" fields;
      extra = extra ["status"; "metadata"; "params"; "startedAt"; "completedAt"; "error"; "failureClass"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_cancelled = struct
  type t = { status : string; metadata : Yojson.Raw.t; params : Yojson.Raw.t; started_at : string Types.presence; completed_at : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      metadata = required identity "metadata" fields;
      params = required identity "params" fields;
      started_at = optional string "startedAt" fields;
      completed_at = required string "completedAt" fields;
      extra = extra ["status"; "metadata"; "params"; "startedAt"; "completedAt"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_record = struct
  type t = { job : Yojson.Raw.t; last_progress_at : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      job = required identity "job" fields;
      last_progress_at = required string "lastProgressAt" fields;
      extra = extra ["job"; "lastProgressAt"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_claimed_result = struct
  type t = { response : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      response = required identity "response" fields;
      extra = extra ["response"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Dispatcher_config = struct
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; queue : Yojson.Raw.t; port : Yojson.Raw.t; timing : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kb = required identity "kb" fields;
      gateway_url = required string "gatewayUrl" fields;
      identity = required identity "identity" fields;
      queue = required identity "queue" fields;
      port = required identity "port" fields;
      timing = required identity "timing" fields;
      log_level = required identity "logLevel" fields;
      log_format = required identity "logFormat" fields;
      extra = extra ["kb"; "gatewayUrl"; "identity"; "queue"; "port"; "timing"; "logLevel"; "logFormat"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Worker_config = struct
  type t = { knowledge_bases : Yojson.Raw.t; model_catalogue : string; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      knowledge_bases = required identity "knowledgeBases" fields;
      model_catalogue = required string "modelCatalogue" fields;
      port = required identity "port" fields;
      log_level = required identity "logLevel" fields;
      log_format = required identity "logFormat" fields;
      extra = extra ["knowledgeBases"; "modelCatalogue"; "port"; "logLevel"; "logFormat"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Worker_engine_config = struct
  type t = { engine : Yojson.Raw.t; jobs : Yojson.Raw.t; base_url : string; api_key_env : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      engine = required identity "engine" fields;
      jobs = required identity "jobs" fields;
      base_url = required string "baseUrl" fields;
      api_key_env = optional string "apiKeyEnv" fields;
      extra = extra ["engine"; "jobs"; "baseUrl"; "apiKeyEnv"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Worker_knowledge_base_config = struct
  type t = { domain : string; gateway_url : string; identity : Yojson.Raw.t; engines : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      domain = required string "domain" fields;
      gateway_url = required string "gatewayUrl" fields;
      identity = required identity "identity" fields;
      engines = required identity "engines" fields;
      extra = extra ["domain"; "gatewayUrl"; "identity"; "engines"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Worker_health = struct
  type t = { status : string; knowledge_bases : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      knowledge_bases = required identity "knowledgeBases" fields;
      extra = extra ["status"; "knowledgeBases"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Worker_knowledge_base_health = struct
  type t = { domain : string; state : string; did : string Types.presence; engines : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      domain = required string "domain" fields;
      state = required string "state" fields;
      did = optional string "did" fields;
      engines = optional identity "engines" fields;
      extra = extra ["domain"; "state"; "did"; "engines"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Worker_engine_health = struct
  type t = { engine : Yojson.Raw.t; jobs : Yojson.Raw.t; last_queued_event_at : Yojson.Raw.t; last_claim_at : Yojson.Raw.t; last_finished_at : Yojson.Raw.t; last_activity_at : Yojson.Raw.t; active_job : Yojson.Raw.t; jobs_completed : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      engine = required identity "engine" fields;
      jobs = required identity "jobs" fields;
      last_queued_event_at = required identity "lastQueuedEventAt" fields;
      last_claim_at = required identity "lastClaimAt" fields;
      last_finished_at = required identity "lastFinishedAt" fields;
      last_activity_at = required identity "lastActivityAt" fields;
      active_job = required identity "activeJob" fields;
      jobs_completed = required identity "jobsCompleted" fields;
      extra = extra ["engine"; "jobs"; "lastQueuedEventAt"; "lastClaimAt"; "lastFinishedAt"; "lastActivityAt"; "activeJob"; "jobsCompleted"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Weaver_config = struct
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; graph : Yojson.Raw.t; cursors_path : Yojson.Raw.t; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kb = required identity "kb" fields;
      gateway_url = required string "gatewayUrl" fields;
      identity = required identity "identity" fields;
      archivist = required identity "archivist" fields;
      graph = required identity "graph" fields;
      cursors_path = required identity "cursorsPath" fields;
      port = required identity "port" fields;
      log_level = required identity "logLevel" fields;
      log_format = required identity "logFormat" fields;
      extra = extra ["kb"; "gatewayUrl"; "identity"; "archivist"; "graph"; "cursorsPath"; "port"; "logLevel"; "logFormat"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Neo4j_graph_config = struct
  type t = { type_ : string; uri : string; username : string; password_env : string; database : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      uri = required string "uri" fields;
      username = required string "username" fields;
      password_env = required string "passwordEnv" fields;
      database = required string "database" fields;
      extra = extra ["type"; "uri"; "username"; "passwordEnv"; "database"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Janus_graph_config = struct
  type t = { type_ : string; host : string; port : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      host = required string "host" fields;
      port = required identity "port" fields;
      extra = extra ["type"; "host"; "port"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Neptune_graph_config = struct
  type t = { type_ : string; endpoint : string; port : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      endpoint = required string "endpoint" fields;
      port = required identity "port" fields;
      extra = extra ["type"; "endpoint"; "port"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Memory_graph_config = struct
  type t = { type_ : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      extra = extra ["type"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Smelter_config = struct
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; embedding : Yojson.Raw.t; vectors : Yojson.Raw.t; chunking : Yojson.Raw.t; pdfs_at_once : Yojson.Raw.t; cursors_path : Yojson.Raw.t; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kb = required identity "kb" fields;
      gateway_url = required string "gatewayUrl" fields;
      identity = required identity "identity" fields;
      archivist = required identity "archivist" fields;
      embedding = required identity "embedding" fields;
      vectors = required identity "vectors" fields;
      chunking = required identity "chunking" fields;
      pdfs_at_once = required identity "pdfsAtOnce" fields;
      cursors_path = required identity "cursorsPath" fields;
      port = required identity "port" fields;
      log_level = required identity "logLevel" fields;
      log_format = required identity "logFormat" fields;
      extra = extra ["kb"; "gatewayUrl"; "identity"; "archivist"; "embedding"; "vectors"; "chunking"; "pdfsAtOnce"; "cursorsPath"; "port"; "logLevel"; "logFormat"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Librarian_config = struct
  type t = { kb : Yojson.Raw.t; gateway_url : string; identity : Yojson.Raw.t; archivist : Yojson.Raw.t; graph : Yojson.Raw.t; vectors : Yojson.Raw.t; embedding : Yojson.Raw.t; matcher : Yojson.Raw.t; gatherer : Yojson.Raw.t; model_catalogue : string; gather : Yojson.Raw.t; search : Yojson.Raw.t; port : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      kb = required identity "kb" fields;
      gateway_url = required string "gatewayUrl" fields;
      identity = required identity "identity" fields;
      archivist = required identity "archivist" fields;
      graph = required identity "graph" fields;
      vectors = required identity "vectors" fields;
      embedding = required identity "embedding" fields;
      matcher = required identity "matcher" fields;
      gatherer = required identity "gatherer" fields;
      model_catalogue = required string "modelCatalogue" fields;
      gather = required identity "gather" fields;
      search = required identity "search" fields;
      port = required identity "port" fields;
      log_level = required identity "logLevel" fields;
      log_format = required identity "logFormat" fields;
      extra = extra ["kb"; "gatewayUrl"; "identity"; "archivist"; "graph"; "vectors"; "embedding"; "matcher"; "gatherer"; "modelCatalogue"; "gather"; "search"; "port"; "logLevel"; "logFormat"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Librarian_engine_config = struct
  type t = { engine : Yojson.Raw.t; base_url : string; api_key_env : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      engine = required identity "engine" fields;
      base_url = required string "baseUrl" fields;
      api_key_env = optional string "apiKeyEnv" fields;
      extra = extra ["engine"; "baseUrl"; "apiKeyEnv"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Ollama_embedding_config = struct
  type t = { type_ : string; model : string; base_url : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      model = required string "model" fields;
      base_url = required string "baseUrl" fields;
      extra = extra ["type"; "model"; "baseUrl"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Voyage_embedding_config = struct
  type t = { type_ : string; model : string; endpoint : string; api_key_env : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      model = required string "model" fields;
      endpoint = required string "endpoint" fields;
      api_key_env = required string "apiKeyEnv" fields;
      extra = extra ["type"; "model"; "endpoint"; "apiKeyEnv"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Qdrant_vectors_config = struct
  type t = { type_ : string; host : string; port : Yojson.Raw.t; token_env : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      host = required string "host" fields;
      port = required identity "port" fields;
      token_env = required string "tokenEnv" fields;
      extra = extra ["type"; "host"; "port"; "tokenEnv"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Memory_vectors_config = struct
  type t = { type_ : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      type_ = required string "type" fields;
      extra = extra ["type"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Dispatcher_health = struct
  type t = { status : string; queue : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      status = required string "status" fields;
      queue = required string "queue" fields;
      extra = extra ["status"; "queue"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Archivist_config = struct
  type t = { gateway_url : string; identity : Yojson.Raw.t; root : string; state_home : string; anchored_text_dir : string; engines : Yojson.Raw.t; port : Yojson.Raw.t; skip_rebuild : bool; staging : Yojson.Raw.t; log_level : Yojson.Raw.t; log_format : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      gateway_url = required string "gatewayUrl" fields;
      identity = required identity "identity" fields;
      root = required string "root" fields;
      state_home = required string "stateHome" fields;
      anchored_text_dir = required string "anchoredTextDir" fields;
      engines = required identity "engines" fields;
      port = required identity "port" fields;
      skip_rebuild = required bool "skipRebuild" fields;
      staging = required identity "staging" fields;
      log_level = required identity "logLevel" fields;
      log_format = required identity "logFormat" fields;
      extra = extra ["gatewayUrl"; "identity"; "root"; "stateHome"; "anchoredTextDir"; "engines"; "port"; "skipRebuild"; "staging"; "logLevel"; "logFormat"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_annotations = struct
  type t = { resource_id : Yojson.Raw.t; annotations : Yojson.Raw.t; version : Yojson.Raw.t; updated_at : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      annotations = required identity "annotations" fields;
      version = required identity "version" fields;
      updated_at = required string "updatedAt" fields;
      extra = extra ["resourceId"; "annotations"; "version"; "updatedAt"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_view = struct
  type t = { resource : Yojson.Raw.t; annotations : Yojson.Raw.t; last_sequence : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource = required identity "resource" fields;
      annotations = required identity "annotations" fields;
      last_sequence = required identity "lastSequence" fields;
      extra = extra ["resource"; "annotations"; "lastSequence"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Entity_types_projection = struct
  type t = { entity_types : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      entity_types = required identity "entityTypes" fields;
      extra = extra ["entityTypes"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Tag_schemas_projection = struct
  type t = { tag_schemas : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      tag_schemas = required identity "tagSchemas" fields;
      extra = extra ["tagSchemas"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Profiles_projection = struct
  type t = { profiles : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      profiles = required identity "profiles" fields;
      extra = extra ["profiles"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Profile = struct
  type t = { name : string; since : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      name = required string "name" fields;
      since = required string "since" fields;
      extra = extra ["name"; "since"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Storage_uri_entry = struct
  type t = { uri : string; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      uri = required string "uri" fields;
      resource_id = required identity "resourceId" fields;
      extra = extra ["uri"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Anchored_text_extracted_entry = struct
  type t = { v : Yojson.Raw.t; stamp : string; text : string; lines : Yojson.Raw.t; method_ : string; pdf_class : string Types.presence; ocr_confidence : Yojson.Raw.t Types.presence; unread_pages : Yojson.Raw.t Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      v = required identity "v" fields;
      stamp = required string "stamp" fields;
      text = required string "text" fields;
      lines = required identity "lines" fields;
      method_ = required string "method" fields;
      pdf_class = optional string "pdfClass" fields;
      ocr_confidence = optional identity "ocrConfidence" fields;
      unread_pages = optional identity "unreadPages" fields;
      extra = extra ["v"; "stamp"; "text"; "lines"; "method"; "pdfClass"; "ocrConfidence"; "unreadPages"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Anchored_text_declined_entry = struct
  type t = { v : Yojson.Raw.t; stamp : string; declined : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      v = required identity "v" fields;
      stamp = required string "stamp" fields;
      declined = required string "declined" fields;
      extra = extra ["v"; "stamp"; "declined"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Anchored_text_entries = struct
  type t = { checksums : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      checksums = required identity "checksums" fields;
      extra = extra ["checksums"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Anchored_text_stamp = struct
  type t = { stamp : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      stamp = required string "stamp" fields;
      extra = extra ["stamp"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Anchored_text_write = struct
  type t = { content_checksum : string; entry : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      content_checksum = required string "contentChecksum" fields;
      entry = required identity "entry" fields;
      extra = extra ["contentChecksum"; "entry"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Archivist_engines = struct
  type t = { jobs : Yojson.Raw.t; actors : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      jobs = required identity "jobs" fields;
      actors = required identity "actors" fields;
      extra = extra ["jobs"; "actors"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Engine = struct
  type t = { provider : string; model : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      provider = required string "provider" fields;
      model = required string "model" fields;
      extra = extra ["provider"; "model"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_failed = struct
  type t = { code : string Types.presence; message : string; details : string Types.presence; annotation_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = optional string "code" fields;
      message = required string "message" fields;
      details = optional string "details" fields;
      annotation_id = required identity "annotationId" fields;
      extra = extra ["code"; "message"; "details"; "annotationId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Gather_resource_failed = struct
  type t = { code : string Types.presence; message : string; details : string Types.presence; resource_id : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = optional string "code" fields;
      message = required string "message" fields;
      details = optional string "details" fields;
      resource_id = required identity "resourceId" fields;
      extra = extra ["code"; "message"; "details"; "resourceId"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Browse_directory_failed = struct
  type t = { code : string Types.presence; message : string; details : string Types.presence; path : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      code = optional string "code" fields;
      message = required string "message" fields;
      details = optional string "details" fields;
      path = required string "path" fields;
      extra = extra ["code"; "message"; "details"; "path"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Mark_delegate_timeout_event = struct
  type t = { resource_id : Yojson.Raw.t; motivation : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      motivation = required identity "motivation" fields;
      extra = extra ["resourceId"; "motivation"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Resource_error_event = struct
  type t = { resource_id : Yojson.Raw.t; message : string; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      message = required string "message" fields;
      extra = extra ["resourceId"; "message"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Job_cancel_result = struct
  type t = { cancelled : bool; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      cancelled = required bool "cancelled" fields;
      extra = extra ["cancelled"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Weave_applied = struct
  type t = { resource_id : Yojson.Raw.t; sequence_number : Yojson.Raw.t; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      sequence_number = required identity "sequenceNumber" fields;
      extra = extra ["resourceId"; "sequenceNumber"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Smelt_settled = struct
  type t = { resource_id : Yojson.Raw.t; content_checksum : string; outcome : string; reason : string Types.presence; extra : (string * Yojson.Raw.t) list }
  let project fields =
    {
      resource_id = required identity "resourceId" fields;
      content_checksum = required string "contentChecksum" fields;
      outcome = required string "outcome" fields;
      reason = optional string "reason" fields;
      extra = extra ["resourceId"; "contentChecksum"; "outcome"; "reason"] fields;
    }
  let of_model model = project (object_fields (Models.json model))
end
module Agent = struct
  type t = Person of Agent_person.t | Organization of Agent_organization.t | Software of Agent_software.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "@type" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "Person" -> Some (Person (Agent_person.project fields))
      | "Organization" -> Some (Organization (Agent_organization.project fields))
      | "Software" -> Some (Software (Agent_software.project fields))
      | _ -> None)
    | _ -> None
end
module Annotation_body = struct
  type t = TextualBody of Textual_body.t | SpecificResource of Specific_resource.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "type" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "TextualBody" -> Some (TextualBody (Textual_body.project fields))
      | "SpecificResource" -> Some (SpecificResource (Specific_resource.project fields))
      | _ -> None)
    | _ -> None
end
module Anchored_text_answer = struct
  type t = Extracted of Extracted_text.t | Declined of Extraction_declined.t | NotYet of Anchored_text_absent.t | NoMap of Anchored_text_absent.t | Unknown of Anchored_text_absent.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "kind" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "extracted" -> Some (Extracted (Extracted_text.project fields))
      | "declined" -> Some (Declined (Extraction_declined.project fields))
      | "not-yet" -> Some (NotYet (Anchored_text_absent.project fields))
      | "no-map" -> Some (NoMap (Anchored_text_absent.project fields))
      | "unknown" -> Some (Unknown (Anchored_text_absent.project fields))
      | _ -> None)
    | _ -> None
end
module Directory_entry = struct
  type t = File of File_entry.t | Dir of Dir_entry.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "type" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "file" -> Some (File (File_entry.project fields))
      | "dir" -> Some (Dir (Dir_entry.project fields))
      | _ -> None)
    | _ -> None
end
module Extraction_outcome = struct
  type t = Extracted of Extracted_text.t | Declined of Extraction_declined.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "kind" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "extracted" -> Some (Extracted (Extracted_text.project fields))
      | "declined" -> Some (Declined (Extraction_declined.project fields))
      | _ -> None)
    | _ -> None
end
module Job_complete_command = struct
  type t = Mark of Mark_job_complete_command.t | Yield of Yield_job_complete_command.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "jobType" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "mark" -> Some (Mark (Mark_job_complete_command.project fields))
      | "yield" -> Some (Yield (Yield_job_complete_command.project fields))
      | _ -> None)
    | _ -> None
end
module Job_create_command = struct
  type t = Mark of Mark_job_create_command.t | Yield of Yield_job_create_command.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "jobType" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "mark" -> Some (Mark (Mark_job_create_command.project fields))
      | "yield" -> Some (Yield (Yield_job_create_command.project fields))
      | _ -> None)
    | _ -> None
end
module Job_progress_message = struct
  type t = Loading of Job_progress_loading.t | Analyzing of Job_progress_analyzing.t | AnalyzingTags of Job_progress_analyzing_tags.t | GeneratingResource of Job_progress_generating_resource.t | CreatingResource of Job_progress_creating_resource.t | CompleteGenerated of Job_progress_complete_generated.t | DetectingEntities of Job_progress_detecting_entities.t | CreatingAnnotations of Job_progress_creating_annotations.t | CreatingTagAnnotations of Job_progress_creating_tag_annotations.t | CompleteCreated of Job_progress_complete_created.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "code" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "loading" -> Some (Loading (Job_progress_loading.project fields))
      | "analyzing" -> Some (Analyzing (Job_progress_analyzing.project fields))
      | "analyzing-tags" -> Some (AnalyzingTags (Job_progress_analyzing_tags.project fields))
      | "generating-resource" -> Some (GeneratingResource (Job_progress_generating_resource.project fields))
      | "creating-resource" -> Some (CreatingResource (Job_progress_creating_resource.project fields))
      | "complete-generated" -> Some (CompleteGenerated (Job_progress_complete_generated.project fields))
      | "detecting-entities" -> Some (DetectingEntities (Job_progress_detecting_entities.project fields))
      | "creating-annotations" -> Some (CreatingAnnotations (Job_progress_creating_annotations.project fields))
      | "creating-tag-annotations" -> Some (CreatingTagAnnotations (Job_progress_creating_tag_annotations.project fields))
      | "complete-created" -> Some (CompleteCreated (Job_progress_complete_created.project fields))
      | _ -> None)
    | _ -> None
end
module Job_queued_event = struct
  type t = Mark of Mark_job_queued_event.t | Yield of Yield_job_queued_event.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "jobType" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "mark" -> Some (Mark (Mark_job_queued_event.project fields))
      | "yield" -> Some (Yield (Yield_job_queued_event.project fields))
      | _ -> None)
    | _ -> None
end
module Kb_endpoint = struct
  type t = Http of Http_endpoint.t | Local of Local_endpoint.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "kind" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "http" -> Some (Http (Http_endpoint.project fields))
      | "local" -> Some (Local (Local_endpoint.project fields))
      | _ -> None)
    | _ -> None
end
module Selector = struct
  type t = TextPositionSelector of Text_position_selector.t | TextQuoteSelector of Text_quote_selector.t | SvgSelector of Svg_selector.t | FragmentSelector of Fragment_selector.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "type" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "TextPositionSelector" -> Some (TextPositionSelector (Text_position_selector.project fields))
      | "TextQuoteSelector" -> Some (TextQuoteSelector (Text_quote_selector.project fields))
      | "SvgSelector" -> Some (SvgSelector (Svg_selector.project fields))
      | "FragmentSelector" -> Some (FragmentSelector (Fragment_selector.project fields))
      | _ -> None)
    | _ -> None
end
module Mark_job_params = struct
  type t = Highlighting of Highlighting_job_params.t | Commenting of Commenting_job_params.t | Assessing of Assessing_job_params.t | Linking of Linking_job_params.t | Tagging of Tagging_job_params.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "motivation" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "highlighting" -> Some (Highlighting (Highlighting_job_params.project fields))
      | "commenting" -> Some (Commenting (Commenting_job_params.project fields))
      | "assessing" -> Some (Assessing (Assessing_job_params.project fields))
      | "linking" -> Some (Linking (Linking_job_params.project fields))
      | "tagging" -> Some (Tagging (Tagging_job_params.project fields))
      | _ -> None)
    | _ -> None
end
module Job_filter = struct
  type t = Mark of Mark_job_filter.t | Yield of Yield_job_filter.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "jobType" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "mark" -> Some (Mark (Mark_job_filter.project fields))
      | "yield" -> Some (Yield (Yield_job_filter.project fields))
      | _ -> None)
    | _ -> None
end
module Job = struct
  type t = Pending of Job_pending.t | Running of Job_running.t | Complete of Job_complete.t | Failed of Job_failed.t | Cancelled of Job_cancelled.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "status" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "pending" -> Some (Pending (Job_pending.project fields))
      | "running" -> Some (Running (Job_running.project fields))
      | "complete" -> Some (Complete (Job_complete.project fields))
      | "failed" -> Some (Failed (Job_failed.project fields))
      | "cancelled" -> Some (Cancelled (Job_cancelled.project fields))
      | _ -> None)
    | _ -> None
end
module Graph_config = struct
  type t = Neo4j of Neo4j_graph_config.t | Janusgraph of Janus_graph_config.t | Neptune of Neptune_graph_config.t | Memory of Memory_graph_config.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "type" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "neo4j" -> Some (Neo4j (Neo4j_graph_config.project fields))
      | "janusgraph" -> Some (Janusgraph (Janus_graph_config.project fields))
      | "neptune" -> Some (Neptune (Neptune_graph_config.project fields))
      | "memory" -> Some (Memory (Memory_graph_config.project fields))
      | _ -> None)
    | _ -> None
end
module Embedding_config = struct
  type t = Ollama of Ollama_embedding_config.t | Voyage of Voyage_embedding_config.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "type" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "ollama" -> Some (Ollama (Ollama_embedding_config.project fields))
      | "voyage" -> Some (Voyage (Voyage_embedding_config.project fields))
      | _ -> None)
    | _ -> None
end
module Vectors_config = struct
  type t = Qdrant of Qdrant_vectors_config.t | Memory of Memory_vectors_config.t
  let of_model model =
    let fields = object_fields (Models.json model) in
    match List.assoc_opt "type" fields with
    | Some (`Stringlit literal) -> (match string (`Stringlit literal) with
      | "qdrant" -> Some (Qdrant (Qdrant_vectors_config.project fields))
      | "memory" -> Some (Memory (Memory_vectors_config.project fields))
      | _ -> None)
    | _ -> None
end
