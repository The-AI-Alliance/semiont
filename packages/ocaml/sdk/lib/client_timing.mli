(* Generated from protocol/specs/src/client/timing.json. Do not edit. *)

[@@@ocamlformat "disable"]

type retry = { attempts : int; initial_delay_ms : int; max_delay_ms : int }
val bus_request_timeout_ms : int
val emit_timeout_ms : int
val emit_retry : retry
val http_request_timeout_ms : int
val request_retry_pause_ms : int
val stream_open_timeout_ms : int
val reconnect_ms : int
val max_reconnect_ms : int
val degraded_threshold_ms : int
val linger_ms : int
val seen_event_ids_count : int
val reconnect_debounce_ms : int
val lazy_remove_ms : int
val refresh_retry : retry
val refresh_before_exp_ms : int
val min_refresh_delay_ms : int
val device_poll_ms : int
val device_slow_down_ms : int
val device_poll_floor_ms : int
val invalidation_window_ms : int
val save_debounce_ms : int
val max_stored_bytes_count : int
val errors_kept_for_first_reader_count : int
val job_silence_ms : int
val job_status_poll_ms : int
val job_poll_ms : int
val job_poll_timeout_ms : int
val generation_stall_floor_ms : int
val generation_stall_per_token_ms : int
val generation_stall_assumed_tokens_count : int
val delegate_silence_ms : int
val job_claim_timeout_ms : int
val held_job_stall_ms : int
val held_job_stall_check_ms : int
val mark_commit_timeout_ms : int
val generated_text_asks_count : int
val anchored_text_reask_ms : int
val hover_delay_ms : int
val search_debounce_ms : int
val discovery_interval_ms : int
val checks_at_once_count : int
