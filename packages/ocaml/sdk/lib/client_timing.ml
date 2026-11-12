(* Generated from protocol/specs/src/client/timing.json. Do not edit. *)

[@@@ocamlformat "disable"]

type retry = { attempts : int; initial_delay_ms : int; max_delay_ms : int }
let bus_request_timeout_ms = 30000
let emit_timeout_ms = 30000
let emit_retry = { attempts = 4; initial_delay_ms = 1000; max_delay_ms = 4000 }
let http_request_timeout_ms = 30000
let request_retry_pause_ms = 300
let stream_open_timeout_ms = 30000
let reconnect_ms = 5000
let max_reconnect_ms = 60000
let degraded_threshold_ms = 3000
let linger_ms = 1000
let seen_event_ids_count = 512
let reconnect_debounce_ms = 100
let lazy_remove_ms = 5000
let refresh_retry = { attempts = 4; initial_delay_ms = 500; max_delay_ms = 4000 }
let refresh_before_exp_ms = 300000
let min_refresh_delay_ms = 10000
let device_poll_ms = 5000
let device_slow_down_ms = 5000
let device_poll_floor_ms = 1000
let invalidation_window_ms = 1000
let save_debounce_ms = 50
let max_stored_bytes_count = 2097152
let errors_kept_for_first_reader_count = 100
let job_silence_ms = 10000
let job_status_poll_ms = 5000
let job_poll_ms = 1000
let job_poll_timeout_ms = 60000
let generation_stall_floor_ms = 120000
let generation_stall_per_token_ms = 75
let generation_stall_assumed_tokens_count = 500
let delegate_silence_ms = 180000
let job_claim_timeout_ms = 10000
let held_job_stall_ms = 900000
let held_job_stall_check_ms = 60000
let mark_commit_timeout_ms = 60000
let generated_text_asks_count = 8
let anchored_text_reask_ms = 5000
let hover_delay_ms = 150
let search_debounce_ms = 250
let discovery_interval_ms = 5000
let checks_at_once_count = 4
