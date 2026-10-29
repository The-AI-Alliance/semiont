# Weaver conformance suite

A black-box suite for the Weaver: the process a weaver image runs. It starts
the Weaver from a command and meets it only where the rest of Semiont does: in
the graph it writes, on the bus, and at its health port. It checks what the
Weaver does against
[docs/protocol/WEAVER.md](../../../docs/protocol/WEAVER.md).

The suite imports nothing from a Weaver. The lines that name one are
`WEAVER_SERVICES` in [harness/paths.ts](../harness/paths.ts): today Semiont's
own, the Python service of [`images/weaver`](../../../images/weaver/README.md),
started by the interpreter of its locked environment. Every case runs against
every entry.

The suite reads the graph with a reader of its own: its own Cypher, on a
connection of its own ([harness/weaver-world.ts](../harness/weaver-world.ts)),
and its own reading of each row
([harness/graph-codec.ts](../harness/graph-codec.ts)). What a store holds is
stated by
[`specs/src/graph/codec-cases.json`](../../../specs/src/graph/codec-cases.json),
the case table the Weaver's codec is held to, and the harness's reader is held
to the same table (`harness/graph-codec.test.ts`, which the gateway project
runs with the harness's other tests of itself). So the suite judges a Weaver
by something other than the Weaver's own code. The other way would be for
`semiont_graph` to offer a small command that prints a resource's rows,
decoded, as JSON, which the harness would call: one codec in the repository
and no copy here, at the cost that the suite would then read a Weaver through
the Weaver's codec.

That reader writes nothing. Two things the suite does in the database itself,
in Cypher, on the same connection: it empties it, and it takes one annotation
out of it behind a Weaver's back.

## The world around a Weaver

Each file runs its cases in a world of its own
([harness/weaver-world.ts](../harness/weaver-world.ts)):

- an Archivist world ([harness/archivist-world.ts](../harness/archivist-world.ts)):
  a knowledge base, a real Archivist that records and answers, a real gateway,
  and the trusted issuer, which grants the Weaver's service account;
- a real neo4j, cleared when the world is made;
- the Weaver, started with its settings and its environment, and waited for
  until its first sweep of the record is done and its reconcile has ended.

**Nothing is recorded but through the Archivist.** A case uploads as a person,
asks for annotations as a person, and commits a job's work as a worker; the
Weaver is given the events the record gives it, and the record a case compares
the graph with is the Archivist's own view. No case states a view. A check of
the graph against the record is only a check when the record's side comes
from the record.

**The run is told where its neo4j is,** in `NEO4J_HOST` and `NEO4J_PASSWORD`,
and starts none. Without them it fails, and says so; it is not skipped.
**It clears the database it is given,** so it is given one of its own.
`scripts/ci/neo4j-image.sh` prints the image the launcher starts for an
operator, which is the one to run:

```bash
docker run -d --name weaver-suite-neo4j -p 7687:7687 -e NEO4J_AUTH=neo4j/a-password "$(scripts/ci/neo4j-image.sh)"
NEO4J_HOST=localhost NEO4J_PASSWORD=a-password npm run test:weaver
```

**One world at a time.** The files share one database, which a rebuild of the
whole graph clears, so the project runs its files one after another.

A Weaver is given its settings as its configuration document (`WeaverConfig`),
which the harness writes
([harness/weaver-process.ts](../harness/weaver-process.ts)) into a home
directory of the world's own, and names on its command (`--config`). The
document says where the Archivist listens and where the Weaver keeps its
cursors: a temporary directory inside that home. A Weaver stopped and started
again finds what it kept; one that is replaced starts with nothing.

## What it checks

- **The graph it builds** (`record.test.ts`): a person's highlight, a
  reference bound to another resource and tagged, and work a person asked a
  worker for, each held to what the graph is to hold of the Archivist's view;
  who each is by, the software that made it, and when it was changed; a
  resource's date and attribution; a resource followed through archiving, its
  entity types and an annotation's removal; how far it says it has taken
  each resource's stream; and
  that its own reconcile finds nothing to repair in a graph it has just built.
- **Bringing the graph back** (`repair.test.ts`): what was recorded while it
  was down, with its cursors and with nothing kept; what was lost from the
  graph behind its back, and a graph that was cleaned whole; a rebuild of one
  resource, which leaves another resource's link to it alone; and a rebuild of
  everything.
- **As a process** (`boot.test.ts`): what its health reports; a clean stop;
  and every refusal to start: no service account, no password for the graph
  database, a graph that lives in one process's memory, a gateway that does
  not answer.
- **What it exports** (`telemetry.test.ts`): a Weaver told where to export,
  held to the telemetry table in both directions: every row the table lists
  for it arrives, under its name, and nothing arrives that the table does not
  list.

## Running it

It needs a built gateway and Archivist, the Weaver's Python environment,
`@semiont/core` built (the harness is typed by it), `nats-server` and `git` on
`PATH`, and a neo4j:

```bash
cargo build --release -p semiont-gateway -p semiont-archivist
uv sync --locked --no-dev --all-extras --project images/weaver
npm run build --workspace=@semiont/core
cd tests/conformance
npm ci
NEO4J_HOST=<address> NEO4J_PASSWORD=<password> npm run test:weaver
```
