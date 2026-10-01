# semiont-observability (Rust)

What a Semiont process writes about itself.

- `telemetry` — spans and metrics over OTLP/HTTP, configured from the
  environment the process reads itself; the two counts of the bus, the emits a
  gateway accepted (`semiont.bus.emit`) and the emits a client sent
  (`semiont.bus.sent`); a frame's `bus.recv` span, continuing the trace it was
  sent under; and the readings it takes of itself — start time, restarts under
  a supervisor, runtime lag, memory — and of a fatal panic. It reads the
  active trace for the bus log (`semiont::bus_log`).
- `logging` — log lines on stdout, at the level and in the format a
  configuration document names.
- `alloc` — the allocator's own count of memory in use.

Not yet published.
