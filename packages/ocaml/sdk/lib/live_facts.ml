(* Generated from client/refresh.json. Do not edit. *)

[@@@ocamlformat "disable"]

let queries = [
  ("resource", "browse:resource-requested");
  ("annotation", "browse:annotation-requested");
  ("events", "browse:events-requested");
  ("referencedBy", "gather:referenced-by-requested");
  ("resources", "browse:resources-requested");
  ("matchedResources", "match:resources-requested");
  ("entityTypes", "browse:entity-types-requested");
  ("tagSchemas", "browse:tag-schemas-requested");
  ("engines", "browse:engines-requested");
]
let refresh = [
  ("reopened", None, true, [], [], [], ["resources"; "matchedResources"; "resource"; "entityTypes"; "tagSchemas"; "engines"]);
  ("unreadable", None, true, [], [], [], ["resource"; "annotations"; "annotation"; "events"; "referencedBy"; "resources"; "matchedResources"; "entityTypes"; "tagSchemas"; "engines"]);
  ("bus:resume-gap", None, false, ["scope"], [], [], ["annotations"; "annotation"; "resource"; "events"; "referencedBy"]);
  ("mark:added", None, false, ["resourceId"], [], [], ["annotations"; "events"]);
  ("mark:removed", None, false, ["resourceId"], ["payload"; "annotationId"], [], ["annotations"; "events"]);
  ("mark:delete-ok", None, false, [], ["response"; "annotationId"], [], []);
  ("mark:body-updated", Some "enriched", false, ["resourceId"], ["annotation"; "id"], ["annotation"], ["events"]);
  ("mark:body-updated", Some "unenriched", false, ["resourceId"], ["payload"; "annotationId"], [], ["annotations"; "annotation"; "events"]);
  ("mark:entity-tag-added", None, false, ["resourceId"], [], [], ["annotations"; "resource"; "events"]);
  ("mark:entity-tag-removed", None, false, ["resourceId"], [], [], ["annotations"; "resource"; "events"]);
  ("mark:archived", None, false, ["resourceId"], [], [], ["resource"; "resources"; "matchedResources"]);
  ("mark:unarchived", None, false, ["resourceId"], [], [], ["resource"; "resources"; "matchedResources"]);
  ("yield:created", None, false, ["resourceId"], [], [], ["resource"; "resources"; "matchedResources"]);
  ("yield:updated", None, false, ["resourceId"], [], [], ["resource"; "resources"; "matchedResources"]);
  ("yield:cloned", None, false, ["resourceId"], [], [], ["resource"; "resources"; "matchedResources"]);
  ("yield:moved", None, false, ["resourceId"], [], [], ["resource"; "resources"; "matchedResources"]);
  ("frame:entity-type-added", None, false, [], [], [], ["entityTypes"]);
  ("frame:tag-schema-added", None, false, [], [], [], ["tagSchemas"]);
]
