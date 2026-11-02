# Smelter conformance suite

A black-box suite for the Smelter: the process a smelter image runs. It starts
the Smelter from a command and meets it only where the rest of Semiont does: in
the vector index and the anchored-text store it writes, on the bus, at its
embedding provider and at its health port. It checks what the Smelter does
against [docs/protocol/SMELTER.md](../../../docs/protocol/SMELTER.md).

The suite imports nothing from a Smelter, and nothing a Smelter is built on.
The lines that name one are `SMELTER_SERVICES` in
[harness/paths.ts](../harness/paths.ts): today the Smelter in Python
([`images/smelter`](../../../images/smelter/README.md)), run by the interpreter
of its project's locked environment. Another implementation joins by adding
its line, and every case runs against every entry.

A Smelter is given its settings as the protocol's configuration document,
[`SmelterConfig`](../../../specs/src/components/schemas/SmelterConfig.json),
at the path its `--config` flag names. The harness writes the document
([harness/smelter-process.ts](../harness/smelter-process.ts)) into a home of
the process's own. A refusal to start names the member of the document that
is missing, and the cases that hold a refusal state it.

The Smelter in Python reads a scanned page with the `tesseract` program,
which must be on `PATH`, with its English data, and its environment is made
before a run: `uv sync --locked --no-dev --project images/smelter`.

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
- the anchored-text store, which the Archivist keeps: the Smelter states its
  stamp and stores its entries on the Archivist's surface and mounts none of
  it, and the suite reads the Archivist's files;
- the Smelter, started with its settings and its environment, its cursors
  kept in a file of its home, and waited for until its start has swept the
  record.

**Nothing is recorded but through the Archivist.** A case uploads, updates,
archives, tags and annotates as a person, so the Smelter is given the events
the record gives it and reads the bytes the Archivist serves. What it then
says, a case reads off the bus: a stream of `smelt:settled` is open before any
Smelter is, and every decision it carries is held to its schema.

**The run is told where its Qdrant is,** in `QDRANT_HOST` (its REST port,
6333), and starts none. Without it the run fails, and says so; it is not
skipped. **It clears the index of the database it is given,** so it is given
one of its own. `packages/go/launcher/scripts/qdrant-image.sh` prints the image the launcher
starts for an operator, which is the one to run:

```bash
docker run -d --name smelter-suite-qdrant -p 6333:6333 "$(packages/go/launcher/scripts/qdrant-image.sh)"
QDRANT_HOST=localhost npm run test:smelter
```

**One world at a time.** The files share one database, and every Smelter is
told the same health port, 24101, so the project runs its files one after
another.
For the same reason a case stops the world's Smelter before it starts one that
must refuse to start.

**The index is cleared only while no Smelter runs.** A Smelter makes its
collections when it connects, and asks its provider, each time it makes
them, how wide the model's vectors are: once to make them, and once more to
make them again with what made them stated. One whose collections were
deleted under it fails its next write. So a case stops the Smelter, clears
the index, and starts it again; and the requests that measure the model are
among those the provider records for that start. A case that wants only what came after some point
marks the point (`provider.mark()`) and asks for what was sent since.

**Each start is of a container made again.** A world's `start()` takes away
the cursors an earlier start kept, as every `semiont start` does, so a
Smelter starts every resource the record holds by a reconcile, which runs
after health answers; `start()` waits until the start has swept the record.
A case about what happens while the reconcile runs starts the Smelter to
`serving` only, and waits on `reconciled()`.

## What it checks

- **As a process** (`boot.test.ts`): what its health reports, on a knowledge
  base with nothing in it, of a reconcile with nothing to mend, and after
  events and a reconcile; that an event recorded while its start's reconcile
  runs is applied then; a clean stop; every
  refusal to start, without either half of its service account, without the
  directory of the anchored-text store, and without each setting it is told;
  and that a provider answering 404 as it starts is asked again.
- **As the record changes** (`index.test.ts`): what a recorded text becomes,
  by the table's points and the provider's vectors; a long text's several
  points; an update, an archive and an unarchive; an annotation added and
  removed, one that quotes nothing, and one made on an archived resource;
  entity types rewritten with nothing embedded, a resource's and those of an
  annotation whose body is given a tag; an image and a blank text skipped,
  by reason, and logged; and
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
  types changed, an entry lost, a resource archived, annotations added and
  removed, and an annotation's body given a tag, each while the Smelter was
  stopped; what its reconcile then mends, what it asks of its provider, and
  what it reports. A text it remembers skipping is not read again, and an
  index a Smelter of another cut made is made again and filled whole.
- **Asking its provider** (`provider.test.ts`): a batch cut into slices of
  128, each text given the vector that came back for it; one request at a
  time; a provider that says it is busy, which is asked again; and a request
  that fails, which leaves its resource with no points, and holds up no other
  resource, until the Smelter next starts.
- **What it exports** (`telemetry.test.ts`): told where to export, a Smelter
  exports under its own name every row
  [`specs/src/service-telemetry/telemetry.json`](../../../specs/src/service-telemetry/telemetry.json)
  lists for it that its traffic can make, and nothing the table does not
  list, all of it under the resource the table lists for it, with
  `semiont.kb` the DID of the knowledge base its document names; and its
  gauge of the index comes to say the number of points the index holds.

## Running it

It needs a built gateway and Archivist, the Smelter's environment,
`@semiont/core` built (the harness is typed by it), `nats-server`, `git` and
`tesseract` on `PATH`, and a Qdrant:

```bash
cargo build --release -p semiont-gateway -p semiont-archivist
uv sync --locked --no-dev --project images/smelter
npm run build --workspace=@semiont/core
cd tests/conformance
npm ci
QDRANT_HOST=<address> npm run test:smelter
```
