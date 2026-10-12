# Smelter conformance suite

A black-box suite for the Smelter: the process a smelter image runs. It starts
the Smelter from a command and meets it only where the rest of Semiont does: in
the vector index and the anchored-text store it writes, on the bus, at its
embedding provider and at its health port. It checks what the Smelter does
against [docs/protocol/SMELTER.md](../../../docs/protocol/SMELTER.md).

The suite imports nothing from a Smelter, and nothing a Smelter is built on.
The lines that name one are `SMELTER_SERVICES` in
[harness/paths.ts](../harness/paths.ts): the Smelter in TypeScript, the built
entry of `@semiont/make-meaning`, run by node as its image runs it; and the
Smelter in Python ([`apps/smelter`](../../../apps/smelter/README.md)), run by
the interpreter of its project's locked environment. Each line also says how
its implementation is given its settings, and nothing else in the suite
knows. The first reads the knowledge base's configuration file,
`.semiontconfig`, in its home directory, and the directory of the
anchored-text store from its environment. The second reads the protocol's
configuration document,
[`SmelterConfig`](../../../specs/src/components/schemas/SmelterConfig.json),
at the path its `--config` flag names. The harness writes whichever it is
([harness/smelter-process.ts](../harness/smelter-process.ts)) into a home of
the process's own. A refusal to start names what is missing in the words of
the way the settings were given, and the cases that hold a refusal state
both. Every case runs against every entry.

The Smelter in Python reads a scanned page with the `tesseract` program,
which must be on `PATH`, with its English data, and its environment is made
before a run: `uv sync --locked --no-dev --project apps/smelter`.

The index is read and changed by the suite's own calls to Qdrant's REST
interface ([harness/qdrant.ts](../harness/qdrant.ts)), and never through the
store a Smelter writes with. What a point holds is stated by
[`specs/src/vectors/payload-cases.json`](../../../specs/src/vectors/payload-cases.json);
the collections' names, and the payload members a point is found by, are read
from that table. The other suites' type check leaves this suite's cases and
its world out (`tsconfig.json`), so an error in one of them is this suite's
alone; `npm run test:smelter` checks them with `tsconfig.smelter.json`. Its
setup stays in every suite's check: it declares what `vitest.config.ts`
provides this suite.

## The world around a Smelter

Each file runs its cases in a world of its own
([harness/smelter-world.ts](../harness/smelter-world.ts)):

- an Archivist world ([harness/archivist-world.ts](../harness/archivist-world.ts)):
  a knowledge base, a real Archivist that records and answers and serves a
  resource's bytes, a real gateway, and the trusted issuer, which grants the
  Smelter's service account;
- a real Qdrant, whose index is cleared when the world is made and again when
  it is closed;
- a stand-in for its embedding provider
  ([harness/ollama-embed.ts](../harness/ollama-embed.ts)): an Ollama's
  `POST /api/embed`. A vector is worked out from its text alone, so the same
  text has the same vector and two texts have two. It records every request it
  is sent, and a case can have it answer 404, as for a model not fetched yet,
  answer any other failing status, or hold a request until the case releases
  it;
- the directory of the anchored-text store: the Smelter writes it, the
  Archivist is configured to read it, and the suite reads its files;
- the Smelter, started with its settings and its environment, and waited for
  until its reconcile has ended.

**Nothing is recorded but through the Archivist.** A case uploads, updates,
archives, tags and annotates as a person, so the Smelter is given the events
the record gives it and reads the bytes the Archivist serves. What it then
says, a case reads off the bus: a stream of `smelt:settled` is open before any
Smelter is, and every decision it carries is held to its schema.

**The run is told where its Qdrant is,** in `QDRANT_HOST` (its REST port,
6333), and starts none. Without it the run fails, and says so; it is not
skipped. **It clears the index of the database it is given,** so it is given
one of its own. `scripts/ci/qdrant-image.sh` prints the image the launcher
starts for an operator, which is the one to run:

```bash
docker run -d --name smelter-suite-qdrant -p 6333:6333 "$(scripts/ci/qdrant-image.sh)"
QDRANT_HOST=localhost npm run test:smelter
```

**One world at a time.** The files share one database, and a Smelter's health
port, 24101, is a constant, so the project runs its files one after another.
For the same reason a case stops the world's Smelter before it starts one that
must refuse to start.

**The index is cleared only while no Smelter runs.** A Smelter makes its
collections when it connects, and asks its provider once, then, how wide the
model's vectors are. One whose collections were deleted under it fails its
next write. So a case stops the Smelter, clears the index, and starts it
again; and the request that measures the model is among those the provider
records for that start. A case that wants only what came after some point
marks the point (`provider.mark()`) and asks for what was sent since.

**Reconcile runs after health answers.** A world's `start()` waits until the
reconcile has ended. A case about what happens while it runs starts the
Smelter to `serving` only, and waits on `reconciled()`.

## What it checks

- **As a process** (`boot.test.ts`): what its health reports, on a knowledge
  base with nothing in it and after events and a reconcile; that an event
  recorded while its reconcile runs is applied then; a clean stop; every
  refusal to start, without either half of its service account, without the
  directory of the anchored-text store, and without each setting it is told;
  and that a provider answering 404 as it starts is asked again.
- **As the record changes** (`index.test.ts`): what a recorded text becomes,
  by the table's points and the provider's vectors; a long text's several
  points; an update, an archive and an unarchive; an annotation added and
  removed, and one that quotes nothing; entity types rewritten with nothing
  embedded; an image and a blank text skipped, by reason, and logged; and
  that bytes it cannot read, or text it cannot get vectors for, change
  nothing and stop nothing.
- **Given a PDF** (`pdf.test.ts`): that a PDF with text of its own is indexed
  from it; that what deriving came to is stored under the checksum of the
  bytes, a decline too, before the decision is signalled, and is what the
  Archivist then serves; that a resource is indexed though its entry cannot
  be written; and the rebuild command, naming a resource and naming none:
  what it derives, that it embeds nothing and deletes nothing, and what it
  answers when it could not do every resource.
- **Starting after things changed** (`reconcile.test.ts`): an index and an
  anchored-text store that were cleared, points taken out, bytes and entity
  types changed, an entry lost, a resource archived, and annotations added
  and removed, each while the Smelter was stopped; what its reconcile then
  mends, what it asks of its provider, and what it reports.
- **Asking its provider** (`provider.test.ts`): a batch cut into slices of
  128, each text given the vector that came back for it; one request at a
  time; and a request that fails, which leaves its resource with no points
  until the Smelter next starts.

## Running it

It needs a built gateway and Archivist, the packages built (the Smelter runs
from the `dist` of `@semiont/make-meaning`, over the built packages it
imports), `nats-server` and `git` on `PATH`, and a Qdrant:

```bash
cargo build --release -p semiont-gateway -p semiont-archivist
npm run build:packages
cd tests/conformance
npm ci
QDRANT_HOST=<address> npm run test:smelter
```
