# Haskell conformance drivers

`Main.hs` implements the shared [wire driver protocol](../../../../protocol/conformance/sdk/README.md#the-driver-protocol)
using only the public `semiont` library. Operations run concurrently; subscriptions
register before their acknowledgements, cancellation joins abandoned work, and
EOF closes the client and its reporters. The operation census compares the actual
dispatcher with the protocol's complete operation table.

With `--worker`, it implements the shared
[worker driver protocol](../../../../protocol/conformance/worker/README.md#the-worker-driver)
over `Semiont.Worker`. The transport subscribes to the generated worker channel
profiles. Claims, lifecycle messages, commit probes, cancellations, stalls and
vitals all use the public SDK. Each job is run in a span parented by the carrier
its claim reply brought. Explicit `close` stops the worker before its transport;
EOF exits without settling a held job, as the worker protocol requires.

`LiveMain.hs` implements the live-query protocol over the public client. It
observes all ten query families, fresh reads and invalidation, deletion and
Mark/Yield delegation. One storage survives close/reopen for persisted-cache
cases. `LiveQueries.hs` is generated from the refresh table. Both executables
share protocol decoding and reply formatting in `DriverProtocol.hs`.

Build them in Apple `container` from the repository root:

```sh
bash packages/haskell/run-container.sh
```

The runner copies both executables to `conformance/bin`. Semiont's implementations
file registers wire, worker and live drivers; the live tier is `parity`. Follow their setup for
the gateway, core package, Node dependencies and NATS. Run npm commands inside
Apple `container` locally.

The driver uses the SDK's generated timing settings for every override, real
monotonic time, interruptible absolute waits, independent UUIDs and random jitter.
When the harness supplies `OTEL_EXPORTER_OTLP_ENDPOINT`, the driver configures
standard OpenTelemetry providers and exporters and shuts them down before exit.
That setup belongs to this executable; the SDK library uses the host's providers.
