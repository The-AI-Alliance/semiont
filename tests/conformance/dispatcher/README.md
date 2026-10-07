# Dispatcher conformance suite

A black-box suite for the dispatcher. It starts dispatcher processes and meets
them only as the rest of Semiont does: on the bus, through a real gateway, and
at the health port. It checks what they do against the job protocol as
[docs/protocol/JOBS.md](../../../docs/protocol/JOBS.md) states it, and against
the schemas `specs/` gives every channel. It imports nothing from the
dispatcher: the one line that names an implementation is `DISPATCHER_COMMAND`
in [harness/paths.ts](../harness/paths.ts): the Rust binary
`target/release/semiont-dispatcher`.

## The world around a dispatcher

Each file runs its cases in a world of its own
([harness/dispatcher-world.ts](../harness/dispatcher-world.ts)):

- the trusted issuer, which grants the dispatcher's service account;
- a gateway on the in-process plane, the dispatcher's only route to the bus;
- a JetStream broker for the queue, fresh for every world, so the clocks a
  file sets are the ones the broker's objects are made with;
- the Archivist's Browser, answering the two vocabulary reads `job:create`
  makes over the bus, or absent, for the cases that need it gone;
- the dispatcher, started with `--config` and a `DispatcherConfig` document,
  its clocks shrunk where a case needs them to act within a second.

Cases play people, workers and sidecars. They emit through the gateway and
read the replies off their own streams. Every frame those streams carry must
be what the registry says its channel carries, and a case fails otherwise,
whatever it was about. After every case the world cancels whatever is still
pending, because a claim names jobs by what they are, not by id, and would
otherwise hand one case's job to the next.

## What it checks

- **A job's life** (`lifecycle.test.ts`): admitted, announced, claimed and
  recorded, completed, and read back, end to end.
- **Admission** (`create.test.ts`): what the gateway refuses at its door
  because it is not a job description (a parameter a job does not take, a
  value a job needs left out or empty), every check `job:create` makes and its
  refusal, the resource a job is recorded under, the two reads, and a refusal
  that carries `peer-unavailable` when the Archivist is gone.
- **Announcements** (`announce.test.ts`): a pending job is announced with its
  description less its input, and with nothing the dispatcher added to it.
- **Claims** (`claim.test.ts`): only a worker may claim; a claim takes a job
  that matches one of its filters, each a partial job description, and is
  atomic under simultaneous claims; the record a claim hands out; `job:assign`.
- **Concluding an attempt** (`conclude.test.ts`), **progress and checkpoints**
  (`progress.test.ts`), **cancellation** (`cancel.test.ts`) and **status**
  (`status.test.ts`): each transition, its merge rules, and no effect on a job
  not in the state it needs.
- **The clocks** (`clocks.test.ts`): the re-announce tick, the dead-worker
  sweep, retention and the progress throttle.
- **Restarts and the broker** (`restart.test.ts`): the queue outlives its
  dispatcher, and the dispatcher rides out its broker restarting, but not a
  change of credentials.
- **Boot** (`boot.test.ts`): every refusal to start, the health answer, and a
  clean stop.
- **Environment** (`environment.test.ts`): what each variable
  [`specs/src/service-environment/variables.json`](../../../specs/src/service-environment/variables.json)
  lists for the dispatcher changes, and that a reply continues its request's
  trace.
- **Telemetry** (`observability.test.ts`): the `bus.recv` and `bus.emit` spans
  a job's frames make, the queue's size by every status the spec gives a job,
  and, last, everything exported held, in both directions, to the rows of
  [`specs/src/service-telemetry/telemetry.json`](../../../specs/src/service-telemetry/telemetry.json)
  that list the dispatcher and the rows of
  [`specs/src/sdk-telemetry/telemetry.json`](../../../specs/src/sdk-telemetry/telemetry.json)
  for the SDK transport it reaches the bus through.

Behaviour JOBS.md lists as a known defect is not pinned by any case.

## Running it

```bash
cargo build --release -p semiont-gateway -p semiont-dispatcher
npm run build --workspace=@semiont/core
cd tests/conformance
npm ci
npm run test:dispatcher
```
