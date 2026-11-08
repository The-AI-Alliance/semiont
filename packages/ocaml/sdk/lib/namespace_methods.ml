(* Generated from protocol/specs/src/client/surface.json and protocol/specs/src/bus/registry.json. Do not edit. *)

[@@@ocamlformat "disable"]

module Frame = struct
  let add_entity_type client payload = Client_core.ask client Bus_registry.Operations.frame_add_entity_type payload
  let add_tag_schema client payload = Client_core.ask client Bus_registry.Operations.frame_add_tag_schema payload
end

module Browse = struct
  let resource_events client payload = Client_core.ask client Bus_registry.Operations.browse_events_requested payload
  let annotation_history client payload = Client_core.ask client Bus_registry.Operations.browse_annotation_history_requested payload
  let files client payload = Client_core.ask client Bus_registry.Operations.browse_directory_requested payload
  let kb client payload = Client_core.ask client Bus_registry.Operations.browse_kb_requested payload
  let click client payload = Client_core.publish client Bus_registry.Channels.browse_click payload
  let open_resource client payload = Client_core.publish client Bus_registry.Channels.browse_resource_open payload
  let resource_viewed client ?scope payload = Client_core.signal client ?scope Bus_registry.Channels.browse_resource_viewed payload
end

module Mark = struct
  let annotation client payload = Client_core.ask client Bus_registry.Operations.mark_create_request payload
  let delete client payload = Client_core.ask client Bus_registry.Operations.mark_delete payload
  let archive client payload = Client_core.ask client Bus_registry.Operations.mark_archive payload
  let unarchive client payload = Client_core.ask client Bus_registry.Operations.mark_unarchive payload
  let update_entity_types client payload = Client_core.ask client Bus_registry.Operations.mark_update_entity_types payload
  let request client payload = Client_core.publish client Bus_registry.Channels.mark_requested payload
  let submit client payload = Client_core.publish client Bus_registry.Channels.mark_submit payload
  let report_delete_error client payload = Client_core.publish client Bus_registry.Channels.mark_delete_error payload
end

module Bind = struct
  let body client payload = Client_core.ask client Bus_registry.Operations.bind_update_body payload
  let initiate client payload = Client_core.publish client Bus_registry.Channels.bind_initiate payload
  let report_body_error client payload = Client_core.publish client Bus_registry.Channels.bind_body_error payload
end

module Gather = struct
  let resource client payload = Client_core.ask client Bus_registry.Operations.gather_resource_requested payload
end

module Match = struct
  let request_search client payload = Client_core.publish client Bus_registry.Channels.match_search_requested payload
end

module Yield = struct
  let clone_token client payload = Client_core.ask client Bus_registry.Operations.yield_clone_token_requested payload
  let from_token client payload = Client_core.ask client Bus_registry.Operations.yield_clone_resource_requested payload
  let clone client payload = Client_core.publish client Bus_registry.Channels.yield_clone payload
end

module Beckon = struct
  let attention client ?scope payload = Client_core.drive client ?scope Bus_registry.Channels.beckon_focus payload
  let click client ?scope payload = Client_core.drive client ?scope Bus_registry.Channels.browse_click payload
  let open_resource client ?scope payload = Client_core.drive client ?scope Bus_registry.Channels.browse_resource_open payload
  let sparkle_all client ?scope payload = Client_core.drive client ?scope Bus_registry.Channels.beckon_sparkle payload
  let hover client payload = Client_core.publish client Bus_registry.Channels.beckon_hover payload
  let sparkle client payload = Client_core.publish client Bus_registry.Channels.beckon_sparkle payload
end

module Job = struct
  let status client payload = Client_core.ask client Bus_registry.Operations.job_status_requested payload
  let cancel client payload = Client_core.ask client Bus_registry.Operations.job_cancel_requested payload
end
