(* Generated from protocol/specs/src/client/surface.json. Do not edit. *)

[@@@ocamlformat "disable"]

module B = Semiont.Bus_registry
module C = Semiont.Client

let decode channel payload = match B.decode channel (Yojson.Safe.to_string payload) with
  | Ok decoded -> decoded
  | Error _ -> failwith ("invalid test payload for " ^ B.name channel)

let invoke client ~correlation_id name payload = match name with
  | "frame.addEntityType" -> ignore (C.Frame.add_entity_type client (decode B.Channels.frame_add_entity_type payload)); true
  | "frame.addTagSchema" -> ignore (C.Frame.add_tag_schema client (decode B.Channels.frame_add_tag_schema payload)); true
  | "browse.resourceEvents" -> ignore (C.Browse.resource_events client (decode B.Channels.browse_events_requested payload)); true
  | "browse.annotationHistory" -> ignore (C.Browse.annotation_history client (decode B.Channels.browse_annotation_history_requested payload)); true
  | "browse.files" -> ignore (C.Browse.files client (decode B.Channels.browse_directory_requested payload)); true
  | "browse.kb" -> ignore (C.Browse.kb client (decode B.Channels.browse_kb_requested payload)); true
  | "browse.click" -> ignore (C.Browse.click client (decode B.Channels.browse_click payload)); true
  | "browse.openResource" -> ignore (C.Browse.open_resource client (decode B.Channels.browse_resource_open payload)); true
  | "browse.resourceViewed" -> ignore (C.Browse.resource_viewed client (decode B.Channels.browse_resource_viewed payload)); true
  | "mark.annotation" -> ignore (C.Mark.annotation client (decode B.Channels.mark_create_request payload)); true
  | "mark.delete" -> ignore (C.Mark.delete client (decode B.Channels.mark_delete payload)); true
  | "mark.archive" -> ignore (C.Mark.archive client (decode B.Channels.mark_archive payload)); true
  | "mark.unarchive" -> ignore (C.Mark.unarchive client (decode B.Channels.mark_unarchive payload)); true
  | "mark.updateEntityTypes" -> ignore (C.Mark.update_entity_types client (decode B.Channels.mark_update_entity_types payload)); true
  | "mark.request" -> ignore (C.Mark.request client (decode B.Channels.mark_requested payload)); true
  | "mark.submit" -> ignore (C.Mark.submit client (decode B.Channels.mark_submit payload)); true
  | "mark.reportDeleteError" -> ignore (C.Mark.report_delete_error client (decode B.Channels.mark_delete_error payload)); true
  | "bind.body" -> ignore (C.Bind.body client (decode B.Channels.bind_update_body payload)); true
  | "bind.initiate" -> ignore (C.Bind.initiate client (decode B.Channels.bind_initiate payload)); true
  | "bind.reportBodyError" -> ignore (C.Bind.report_body_error client (decode B.Channels.bind_body_error payload)); true
  | "gather.resource" -> ignore (C.Gather.resource client (decode B.Channels.gather_resource_requested payload)); true
  | "match.requestSearch" -> ignore (C.Match.request_search client ?correlation_id (decode B.Channels.match_search_requested payload)); true
  | "yield.cloneToken" -> ignore (C.Yield.clone_token client (decode B.Channels.yield_clone_token_requested payload)); true
  | "yield.fromToken" -> ignore (C.Yield.from_token client (decode B.Channels.yield_clone_resource_requested payload)); true
  | "yield.clone" -> ignore (C.Yield.clone client (decode B.Channels.yield_clone payload)); true
  | "beckon.attention" -> ignore (C.Beckon.attention client (decode B.Channels.beckon_focus payload)); true
  | "beckon.click" -> ignore (C.Beckon.click client (decode B.Channels.browse_click payload)); true
  | "beckon.openResource" -> ignore (C.Beckon.open_resource client (decode B.Channels.browse_resource_open payload)); true
  | "beckon.sparkleAll" -> ignore (C.Beckon.sparkle_all client (decode B.Channels.beckon_sparkle payload)); true
  | "beckon.hover" -> ignore (C.Beckon.hover client (decode B.Channels.beckon_hover payload)); true
  | "beckon.sparkle" -> ignore (C.Beckon.sparkle client (decode B.Channels.beckon_sparkle payload)); true
  | "job.status" -> ignore (C.Job.status client (decode B.Channels.job_status_requested payload)); true
  | "job.cancel" -> ignore (C.Job.cancel client (decode B.Channels.job_cancel_requested payload)); true
  | _ -> false
