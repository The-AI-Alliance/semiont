# Haskell conformance driver

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

Build it in Apple `container` from the repository root:

```sh
bash packages/haskell/run-container.sh
```

The runner copies the executable to `conformance/bin`. Semiont's implementations
file registers it for the shared SDK wire and worker suites. Follow their setup for
the gateway, core package, Node dependencies and NATS. Run npm commands inside
Apple `container` locally.

The driver uses the SDK's generated timing settings for every override, real
monotonic time, interruptible absolute waits, independent UUIDs and random jitter.
When the harness supplies `OTEL_EXPORTER_OTLP_ENDPOINT`, the driver configures
standard OpenTelemetry providers and exporters and shuts them down before exit.
That setup belongs to this executable; the SDK library uses the host's providers.
