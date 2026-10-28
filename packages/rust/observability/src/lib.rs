//! Semiont's observability: the telemetry a process exports over OTLP/HTTP —
//! its spans, its metrics, the instruments every process shares and the
//! readings it takes of itself — and its log lines. The bus log's trace field
//! is read from here (`semiont::bus_log`).

#![forbid(unsafe_code)]

pub mod alloc;
pub mod logging;
pub mod telemetry;
