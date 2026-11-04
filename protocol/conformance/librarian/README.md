# Librarian conformance suite

A black-box suite for the Librarian: the process a librarian image runs. It
starts the Librarian from a command and meets it only where the rest of
Semiont does: on the bus, at its providers, and at its health port. It checks
what the Librarian does against
[protocol/contract/LIBRARIAN.md](../../contract/LIBRARIAN.md).

The suite imports nothing from a Librarian. What names one is its entry in
`librarianServices` in the run's
[implementations file](../README.md#the-implementations-file). Semiont's names
the Librarian in Python ([`images/librarian`](../../../images/librarian/README.md)),
run by the interpreter of its project's locked environment. Another
implementation joins by adding its entry, and every case runs against every
entry. The Weaver and the Smelter it starts are the file's `python` entries in
`weaverServices` and `smelterServices`.

A Librarian writes nothing, so the suite reads no store to judge it. What a
Librarian reads, the graph and the vector index, is written here by the two
services that write it for an operator: a Weaver and a Smelter, the Python
services of [`images/weaver`](../../../images/weaver/README.md) and
[`images/smelter`](../../../images/smelter/README.md), which the suite starts
beside it. The suite does two things in the databases itself
([harness/librarian-world.ts](../harness/librarian-world.ts)): it empties the
graph database, in Cypher, and it clears the index, by its own calls to
Qdrant. Its world takes one list from the Weaver suite's world
([harness/weaver-world.ts](../harness/weaver-world.ts)): the recorded events a
Weaver follows, by which it knows what `weave:applied` must reach. The other
suites' type check leaves this suite's cases and its world
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
  when it is closed. The Smelter and the Librarian each present the Qdrant a
  token of its own, minted from the Qdrant's key as
  [`protocol/specs/src/vectors/token-cases.json`](../../specs/src/vectors/token-cases.json)
  states, and the suite's own calls present the key;
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
`NEO4J_PASSWORD`, `QDRANT_HOST` and `QDRANT_API_KEY`, the API key its Qdrant
was started with, and starts neither. The Qdrant is run with its JWT access
control on, as the launcher runs one. Without the four it fails, and names
the ones that are missing, and so does a Qdrant that refuses the key or asks
for none; it is not skipped. **It clears the graph database and the index it
is given,** so it is given ones of its own.
`packages/go/launcher/scripts/neo4j-image.sh` and `packages/go/launcher/scripts/qdrant-image.sh` print the images
the launcher starts for an operator, which are the ones to run:

```bash
docker run -d --name librarian-suite-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/a-password "$(packages/go/launcher/scripts/neo4j-image.sh)"
docker run -d --name librarian-suite-qdrant -p 6333:6333 -e QDRANT__SERVICE__API_KEY=a-key -e QDRANT__SERVICE__JWT_RBAC=true "$(packages/go/launcher/scripts/qdrant-image.sh)"
NEO4J_HOST=localhost NEO4J_PASSWORD=a-password QDRANT_HOST=localhost QDRANT_API_KEY=a-key npm run test:librarian
```

**One world at a time.** The files share the two databases, and the health
ports of a Weaver and a Smelter are constants, so the project runs its files
one after another.

**A Librarian is given its settings as the protocol's configuration
document,**
[`LibrarianConfig`](../../specs/src/components/schemas/LibrarianConfig.json),
at the path its `--config` flag names. The harness writes the document
([harness/librarian-process.ts](../harness/librarian-process.ts)) into a home
directory of the world's own. It states no state volume: a Librarian mounts
none, and reads what the world's Archivist records of each resource, and the
profiles of the principals it names, on the bus. It states the health port, a free port the
harness chooses for each world. It states the two numbers a
deployment may leave to their defaults too: how long a gather waits for a
resource's vectors, and the floor of the semantic fallback. The Librarian's
environment holds its service account, the graph database's password, its
token for the vector index and `PATH`, and nothing else. A case that takes a
setting away, or changes one, takes it out of the document or changes it
there.

One read is carried to the real Archivist by the harness. A Librarian reads a
resource's anchored text from the gateway, and the gateway of an Archivist
world asks the harness's stand-in Archivist; for every resource a case makes,
the stand-in answers what the real Archivist answers when it is asked.

## What it checks

- **As a process** (`boot.test.ts`): what its health reports; a clean stop;
  and every refusal to start: no gateway address, no issuer, no address for
  the Archivist, no graph
  database, no vector database, no embedding provider, no model for an actor,
  a graph or a vector index that lives in one process's memory, a settle
  bound that is no time at all or does not end under the stall of a held job,
  half a service account, no password for the graph database, no token for
  the vector index, and a gateway that does not answer. Each refusal must
  name the member of the document, or the variable, that is missing or
  refused.
- **Finding things** (`search.test.ts`): a reference search's candidates from
  each of its four sources, with a score and a reason, and its own resource
  left out, with its model's scoring and without, when the model or the
  embedding provider fails, and its limit; a text search answered by name
  with previews and by meaning with the passage that matched, a later page,
  blank text, its filters by name and by meaning, the floor a hit by meaning
  must reach, a PDF's empty preview, and the empty page of a Librarian whose
  token reads another knowledge base's index and none of its own; what
  refers to a resource, and the failure for a resource nobody made; the
  names of the persons a page and a
  candidate mention; and the limits each
  actor reports of its own engine, with a provider that does not answer left
  out.
- **Gathering** (`gather.test.ts`): around an annotation, the annotation and
  its resource, the text selected with what is before and after it, a linked
  resource with its text and summary, and without the summary when its model
  fails on it, the knowledge graph, entity types and
  their frequencies, the sentence its model writes, similar passages, each
  option, and each failure; around a resource, its text and its neighbours',
  a summary and suggestions when asked, with the texts and without them,
  similar passages by its own vectors,
  and each failure; an annotation's summary; and that gathers for one
  resource are answered one at a time.
- **When a writer is behind** (`barriers.test.ts`): with the Weaver or the
  Smelter stopped by the suite, a gather that waits for the graph and one
  that fails saying the graph is behind; a search answered from a view for a
  resource the graph does not hold yet; a gather that waits for the Smelter's
  decision, one answered at once for a resource the Smelter skips, one
  answered at once, by a Librarian that has heard no decision, for an
  indexed resource that nothing is like and for an image, and one answered
  without similar passages when the settle bound passes; and a
  Librarian that answers as before after it is started again.
- **What it exports** (`telemetry.test.ts`): a Librarian told where to export,
  held to the telemetry table in both directions: every row the table lists
  for it arrives, under its name, and nothing arrives that the table does not
  list; and all of it under the resource the table lists for it, with
  `semiont.kb` the DID of the knowledge base its document names. Its traffic
  is a gather whose model answers and reports its tokens, one whose model
  fails, one around a bound reference whose model fails on the linked
  resource's summary and on the relationship sentence, one that reads a PDF's
  text, one the Smelter does not decide in time, and one for a resource the
  graph does not come to hold: every way a request of a model ends, and
  everything a gather can go without.

## Running it

It needs a built gateway and Archivist, `@semiont/core` built (the harness is
typed by it), the Python environments of the Librarian, the Weaver and the
Smelter, `nats-server`, `git` and the `tesseract` program on `PATH`, a neo4j
and a Qdrant:

```bash
cargo build --release -p semiont-gateway -p semiont-archivist
npm run build --workspace=@semiont/core
uv sync --locked --no-dev --all-extras --project images/weaver
uv sync --locked --no-dev --project images/smelter
uv sync --locked --no-dev --all-extras --project images/librarian
cd protocol/conformance
npm ci
NEO4J_HOST=<address> NEO4J_PASSWORD=<password> QDRANT_HOST=<address> QDRANT_API_KEY=<key> npm run test:librarian
```
