# semiont-observability (Rust)

What a Semiont service writes about itself, and what exports it.

- `telemetry` — spans and metrics over OTLP/HTTP, configured from the
  environment the process reads itself, and registered as the process's
  OpenTelemetry: what [`semiont-telemetry`](../telemetry-rust/README.md)'s
  spans, the transport's among them, report to. With it, the count of the
  emits a gateway accepted (`semiont.bus.emit`); the meter a service makes
  its own instruments on; the readings a process takes of itself — start
  time, restarts under a supervisor, runtime lag, memory — and of a fatal
  panic. It gives the bus log its trace (`semiont::bus_log`).
- `logging` — log lines on stdout, at the level and in the format a
  configuration document names.
- `alloc` — the allocator's own count of memory in use.

A service's: no client links it, which CI holds of the transport, and it is
not published.
