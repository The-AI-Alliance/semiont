# semiont-observability

What a Semiont service writes about itself, and what exports it.

**Not published.** It is a crate of this workspace, built into the
[gateway](../../apps/gateway/README.md) and the
[dispatcher](../../apps/dispatcher/README.md). An application built on the
SDK installs an OpenTelemetry of its own instead:
[`semiont-telemetry`](../telemetry-rust/README.md) says how.

| Module | What it holds |
|---|---|
| `telemetry` | Spans and metrics over OTLP/HTTP, configured from the environment the process reads itself, and registered as the process's OpenTelemetry: what `semiont-telemetry`'s spans, the transport's among them, report to. With it, the count of the emits a gateway accepted (`semiont.bus.emit`); the meter a service makes its own instruments on; the readings a process takes of itself (start time, restarts under a supervisor, runtime lag, memory) and of a fatal panic. It gives the bus log its trace (`semiont::bus_log`). |
| `logging` | Log lines on stdout, at the level and in the format a configuration document names. |
| `alloc` | The allocator's own count of memory in use. |

It is separate from `semiont-telemetry` so that a client links no exporter
and no OpenTelemetry SDK, which CI holds of the transport.
