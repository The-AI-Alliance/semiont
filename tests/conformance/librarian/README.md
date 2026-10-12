# Librarian conformance suite

A black-box suite for the Librarian: the process a librarian image runs. It
starts the Librarian from a command and meets it only where the rest of
Semiont does: on the bus, at its providers, and at its health port. It checks
what the Librarian does against
[docs/protocol/LIBRARIAN.md](../../../docs/protocol/LIBRARIAN.md).

The suite imports nothing from a Librarian. The lines that name one are
`LIBRARIAN_SERVICES` in [harness/paths.ts](../harness/paths.ts): today
Semiont's own, the built entry of
[`@semiont/make-meaning`](../../../packages/make-meaning/README.md), run by
`node`. Every case runs against every entry.

A Librarian writes nothing, so the suite reads no store to judge it. What a
Librarian reads, the graph and the vector index, is written here by the two
services that write it for an operator: a Weaver and a Smelter, the Python
services of [`apps/weaver`](../../../apps/weaver/README.md) and
[`apps/smelter`](../../../apps/smelter/README.md), which the suite starts
beside it. The suite does two things in the databases itself
([harness/librarian-world.ts](../harness/librarian-world.ts)): it empties the
graph database, in Cypher, and it clears the index, by its own calls to
Qdrant. Its world takes one list from the Weaver suite's world
([harness/weaver-world.ts](../harness/weaver-world.ts)): the recorded events a
Weaver follows, by which it knows what `weave:applied` must reach. With that
file comes `@semiont/graph`, which it reads the graph with and this suite
does not use. The other suites' type check leaves this suite's cases and its world
out (`tsconfig.json`), so an error in one of them is this suite's alone;
`npm run test:librarian` checks them with `tsconfig.librarian.json`. Its setup
stays in every suite's check: it declares what `vitest.config.ts` provides
this suite.

## The world around a Librarian

Each file runs its cases in a world of its own
([harness/librarian-world.ts](../harness/librarian-world.ts)):

- an Archivist world ([harness/archivist-world.ts](../harness/archivist-world.ts)):
  a knowledge base, a real Archivist that records, answers and writes the
  views, a real gateway, and the trusted issuer, which grants each of the
  three services an account of its own;
- a real neo4j and a real Qdrant, both cleared when the world is made and
  when it is closed;
- a Weaver, which writes the graph, and a Smelter, which writes the index,
  each started as its own suite starts it;
- a stand-in for the model of each of the Librarian's two actors, the Matcher
  and the Gatherer ([harness/ollama.ts](../harness/ollama.ts)): a case scripts
  what each answers next, and reads the prompts each was sent;
- two stand-ins for the embedding provider
  ([harness/ollama-embed.ts](../harness/ollama-embed.ts)), one the Librarian
  asks and one the Smelter asks, so what the Librarian asked is read apart
  from what the Smelter asked. Both give the same text the same vector;
- the Librarian, started with its settings and its environment, and waited
  for until its health answers and it answers on the bus.

**Nothing is recorded but through the Archivist, and nothing is put in a
store but by its writer.** A case uploads a resource and asks for an
annotation as a person; the Weaver and the Smelter are given the events the
record gives them; and the case waits for what each signals on the bus,
`weave:applied` and `smelt:settled`, as a client hears them. What the
Librarian is then asked about is what the real writers wrote. A store that
lags is staged by stopping its writer before the case records.

**A case asks as a person who is signed in,** and reads the one reply to its
request. Every frame its stream carries is held to what the bus registry says
its channel carries, and the reply it reads is held to its channel's schema
again where it is read.

**A model is asked nothing a case did not script.** A generation no case
scripted fails the case, whatever it was about, and so does a request a
stand-in does not serve.

**The run is told where its databases are,** in `NEO4J_HOST`,
`NEO4J_PASSWORD` and `QDRANT_HOST`, and starts neither. Without the three it
fails, and names the ones that are missing; it is not skipped. **It clears the
graph database and the index it is given,** so it is given ones of its own.
`scripts/ci/neo4j-image.sh` and `scripts/ci/qdrant-image.sh` print the images
the launcher starts for an operator, which are the ones to run:

```bash
docker run -d --name librarian-suite-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/a-password "$(scripts/ci/neo4j-image.sh)"
docker run -d --name librarian-suite-qdrant -p 6333:6333 "$(scripts/ci/qdrant-image.sh)"
NEO4J_HOST=localhost NEO4J_PASSWORD=a-password QDRANT_HOST=localhost npm run test:librarian
```

**One world at a time.** The files share the two databases, and the health
ports of a Librarian, a Weaver and a Smelter are constants, so the project
runs its files one after another.

The TypeScript Librarian is given its settings as it is given them by the
launcher: a `.semiontconfig`, which the harness writes
([harness/librarian-process.ts](../harness/librarian-process.ts)) into a home
directory of the world's own, with the state volume the world's Archivist
writes its views into named by `XDG_STATE_HOME`. The file states both numbers
a deployment may leave to their defaults: how long a gather waits for a
resource's vectors, and the floor of the semantic fallback.

One read is carried to the real Archivist by the harness. A Librarian reads a
resource's anchored text from the gateway, and the gateway of an Archivist
world asks the harness's stand-in Archivist; for every resource a case makes,
the stand-in answers what the real Archivist answers when it is asked.

## What it checks

- **As a process** (`boot.test.ts`): what its health reports; a clean stop;
  and every refusal to start: no gateway address, no issuer, no name for the
  knowledge base, no state volume, no address for the Archivist, no graph
  database, no vector database, no embedding provider, no model for an actor,
  a graph or a vector index that lives in one process's memory, a settle
  bound that is no time at all or does not end under the stall of a held job,
  half a service account, no password for the graph database, and a gateway
  that does not answer.
- **Finding things** (`search.test.ts`): a reference search's candidates from
  each of its four sources, with a score and a reason, with its model's
  scoring and without, when the model or the embedding provider fails, and
  its limit; a text search answered by name with previews and by meaning with
  the passage that matched, a later page, blank text, its filters, the floor
  a hit by meaning must reach, and a PDF's empty preview; what refers to a
  resource; the names of the people a page mentions; and the limits each
  actor reports of its own model, with a provider that does not answer left
  out.
- **Gathering** (`gather.test.ts`): around an annotation, the annotation and
  its resource, the text selected with what is before and after it, a linked
  resource with its text and summary, the knowledge graph, entity types and
  their frequencies, the sentence its model writes, similar passages, each
  option, and each failure; around a resource, its text and its neighbours',
  a summary and suggestions when asked, similar passages by its own vectors,
  and each failure; an annotation's summary; and that gathers for one
  resource are answered one at a time.
- **When a writer is behind** (`barriers.test.ts`): with the Weaver or the
  Smelter stopped by the suite, a gather that waits for the graph and one
  that fails saying the graph is behind; a search answered from a view for a
  resource the graph does not hold yet; a gather that waits for the Smelter's
  decision, one answered at once for a resource the Smelter skips, and one
  answered without similar passages when the settle bound passes; and a
  Librarian that answers as before after it is started again.

## Running it

It needs a built gateway and Archivist, the packages built (the Librarian is
one of them), the Python environments of the Weaver and the Smelter, `node`,
`nats-server`, `git` and the `tesseract` program on `PATH`, a neo4j and a
Qdrant:

```bash
cargo build --release -p semiont-gateway -p semiont-archivist
npm run build:packages
uv sync --locked --no-dev --all-extras --project apps/weaver
uv sync --locked --no-dev --project apps/smelter
cd tests/conformance
npm ci
NEO4J_HOST=<address> NEO4J_PASSWORD=<password> QDRANT_HOST=<address> npm run test:librarian
```
