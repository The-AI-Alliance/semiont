# Dispatcher conformance suite

A black-box suite for the dispatcher. It starts dispatcher processes and meets
them only as the rest of Semiont does: on the bus, through a real gateway, and
at the health port. It checks what they do against the job protocol as
[docs/protocol/JOBS.md](../../../docs/protocol/JOBS.md) states it, and against
the schemas `specs/` gives every channel. It imports nothing from the
dispatcher: the one line that names an implementation is `DISPATCHER_COMMAND`
in [harness/paths.ts](../harness/paths.ts), today make-meaning's
`dispatcher-main.js`.

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
pending, because a claim is by type and would otherwise hand one case's job to
the next.

## What it checks

- **Admission** (`create.test.ts`): every check `job:create` makes and its
  refusal, the resource a job is recorded under, the two reads, and a refusal
  that carries `peer-unavailable` when the Archivist is gone.
- **Claims** (`claim.test.ts`): only a worker may claim; a claim is by type and
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

Behaviour JOBS.md lists as a known defect is not pinned by any case.

## Running it

```bash
(cd apps/gateway && cargo build --release)
npm run build:packages
cd tests/conformance
npm ci
npm run test:dispatcher
```
