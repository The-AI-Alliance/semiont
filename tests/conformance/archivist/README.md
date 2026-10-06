# Archivist conformance suite

A black-box suite for the Archivist. It starts Archivist processes and meets
them only where the rest of Semiont does: on the bus, through a real gateway;
at their HTTP surface, as a service; and in the files they keep, which other
processes read. It checks what they do against
[docs/protocol/ARCHIVIST.md](../../../docs/protocol/ARCHIVIST.md), the schemas
`specs/` gives every channel and every file, and the Archivist's
[API](../../../specs/src/archivist/openapi.json). It imports nothing from the
Archivist: the lines that name an implementation are in
[harness/paths.ts](../harness/paths.ts). There are two while both exist, and
each is judged by the same cases: `ARCHIVIST_COMMAND`, the built
`@semiont/make-meaning` entry point (`npm run test:archivist`), and
`ARCHIVIST_RUST_COMMAND`, the binary `target/release/semiont-archivist`
(`npm run test:archivist-rust`).

## The world around an Archivist

Each file runs its cases in a world of its own
([harness/archivist-world.ts](../harness/archivist-world.ts)):

- a knowledge base's working tree, made fresh, with its committed
  `.semiont/config`, and a git checkout unless the file is about one that is
  not;
- a state volume and an anchored-text store beside it;
- the trusted issuer, which grants the Archivist's service account;
- a gateway on the in-process plane, the Archivist's only route to the bus;
- the Archivist, started with `--config` and an `ArchivistConfig` document.

Cases play people, workers and sidecars, and the Smelter as far as the
Archivist meets it: an entry in the store, the stamp its writer states, and
`smelt:settled`. They emit through the gateway and read replies and facts off
their own streams, call the HTTP surface with a service account's token, and
read the log, the views, the projections, the index and the git index straight
off the disk. Every frame a stream carries must be what the registry says its
channel carries; every response what the Archivist's API declares; every file
what its schema says; and a case fails otherwise, whatever it was about.

## What it checks

- **Boot** (`boot.test.ts`): the health answer, every refusal to start — the
  document unnamed, unreadable, not JSON, or refused by its schema; no service
  account; no `[site] domain`; a knowledge base that syncs git and is not a
  checkout — and a clean stop.
- **Resources** (`resources.test.ts`): an upload stored, recorded and
  published; the line in the log, the view, the index entry, where each is
  filed; the content, the description and the event replay over HTTP, and who
  is admitted to them; every upload refused; new content, archive and
  unarchive, entity types; and the order facts are published in, to a
  resource's scope and to none.
- **Annotations** (`annotations.test.ts`): an annotation assembled, a batch
  committed once however often it is sent, bodies changed, an annotation
  removed, what each reads back as, the annotation a published fact carries,
  and a generated resource linked from the annotation it was generated for.
- **Browse** (`browse.test.ts`): the knowledge base, the vocabulary and its
  seeding, tag schemas, the listing, a resource's events, people named by
  their profile, a directory of the working tree, anchored text under the
  stamp its writer states, and the roster.
- **Clone tokens** (`clone.test.ts`): issued, looked up, spent on a copy over
  the bus and by an upload, and refused.
- **Jobs** (`jobs.test.ts`): the lifecycle recorded in a resource's stream, a
  worker's writes attributed to whoever the job was assigned for, and every
  refusal of a write that cites no job, the wrong job, or the wrong generator.
- **The record across restarts** (`record.test.ts`): sequence numbers after a
  stop and after a crash, every view and projection rebuilt from the log, a
  wrong view corrected and an orphan reaped, the rebuild skipped when the
  document says so, a log read as it is found, and clone tokens forgotten.
- **One tree, two implementations** (`compatibility.test.ts`): what the
  Archivist under test writes, the other rebuilds byte for byte from the log;
  and a tree the other went on from, the first goes on from in turn.
- **Staging** (`staging.test.ts`): what reaches the git index and within what
  bound, what an archive unstages, the branch, a batch that cannot be staged,
  and a knowledge base that does not sync git, which runs none.

Behaviour ARCHIVIST.md lists as a known defect is not pinned by any case. Two
channels the Archivist subscribes to, `yield:mv` and `mark:create`, are not
reachable through a gateway and have no cases.

## Running it

```bash
cargo build --release -p semiont-gateway -p semiont-archivist
npm run build:packages
cd tests/conformance
npm ci
npm run test:archivist
npm run test:archivist-rust
```

It needs `git` and `nats-server` on `PATH`.
