# Weaver

What the Weaver does: the process a weaver image runs. It keeps a graph
database in step with the record. It follows the recorded events that change
what the graph holds, applies each to the graph, says how far it has got, and,
when it starts, repairs what it missed and what the graph lost. What the
record is, and what the Archivist answers, is [ARCHIVIST.md](./ARCHIVIST.md);
what the bus carries is [EVENT-BUS.md](./EVENT-BUS.md).

A Weaver written in another language does what is written here. If the code
deviates from it, the code is wrong, or this document is wrong and is
corrected deliberately. There is no third option.

**How this document is held.** Each rule ends with *Held by* and what fails
when a Weaver breaks it. `weaver/<case>` is the file `<case>.test.ts` of the
weaver conformance suite
([`tests/conformance/weaver`](../../tests/conformance/weaver/README.md)),
which starts a Weaver as a process behind a real gateway and a real Archivist,
records through the Archivist, and reads the graph back from a real database:
the same cases judge every implementation. A path names a runner of one of the
two case tables,
[`specs/src/weaver/fold-cases.json`](../../specs/src/weaver/fold-cases.json)
and
[`specs/src/graph/codec-cases.json`](../../specs/src/graph/codec-cases.json),
which every implementation runs through its own code. A rule marked "Held by
no case" is one nothing checks. `npm run lint:transport-contract` fails when a
case named here does not exist, and when a case of the suite is named by no
rule.

**The graph is a projection, and not a copy.** The record is the system of
record: everything in the graph can be made again from it. The graph holds
what the questions that cross documents need, and no more. An annotation's
attribution list and a comment's text are the views' to keep, and are not in
it. So whether the graph is right is never asked by comparing it with a view:
it is asked against what the graph is to hold of that view, which the codecs'
table states.

## Settings

A Weaver reads its settings from a configuration document, the protocol's
[`WeaverConfig`](../../specs/src/components/schemas/WeaverConfig.json), at the
path its `--config` flag names. The document is resolved: no `${VAR}` is left
in it, and the Weaver defaults nothing it leaves out. It states the gateway's
URL; the issuer the Weaver's service account signs in at; the graph database
([`GraphConfig`](../../specs/src/components/schemas/GraphConfig.json): its
kind, and what that kind needs to be reached, with the name of the environment
variable that holds its password); the file the Weaver keeps its marks in; the
port its health answers on; and how it logs. Whoever starts a Weaver writes
it: the launcher for the Weaver it starts, and anyone else to the same schema.

- **Started with no `--config`, with a path it cannot read, or with a document
  that is not the schema's, it refuses to start,** and says which. A refusal
  names a member of the document and what was expected of it, and never a
  value found there. *Held by `apps/weaver/tests/test_service.py`.*

- **A graph that lives in one process's memory is refused.** It could not be
  shared with a reader of the graph. *Held by `weaver/boot`.*
- **Its service account is `SEMIONT_OIDC_CLIENT_ID` and
  `SEMIONT_OIDC_CLIENT_SECRET` in its environment** ([Environment](#environment)).
  With either missing it refuses to start, and names what is missing.
  *Held by `weaver/boot`.*
- **The database's password is read from the variable its document names.**
  With that variable unset it refuses to start, and names the variable.
  *Held by `weaver/boot`.*

## What it follows

A Weaver signs in as its service account and works as the agent `(semiont,
weaver)`, and reaches everything but the graph through the gateway.

- **It follows nine recorded events:** `yield:created`, `mark:archived`,
  `mark:unarchived`, `mark:added`, `mark:removed`, `mark:body-updated`,
  `mark:entity-tag-added`, `mark:entity-tag-removed` and
  `frame:entity-type-added`. Every other event of a resource's stream passes
  it by, and moves no mark of its. *Held by `weaver/record`.*
- **It reads history from the Archivist, over the bus:** the catalog
  (`browse:resources-requested`, a page at a time), a resource's events
  (`browse:events-requested`) and a resource's annotations
  (`browse:annotations-requested`). It opens no file of the record.
  *Held by `weaver/repair`.*
- **It answers one command,** `weave:rebuild` ([Rebuild](#rebuild)), and
  emits one signal, `weave:applied` ([What it has applied](#what-it-has-applied)).
  *Held by `weaver/repair`.*

## The fold

Each event a Weaver follows changes the graph in one way.
[`fold-cases.json`](../../specs/src/weaver/fold-cases.json) states each as a
history and the graph it leaves, and is the rule; this section says it in
prose.

A table holds the histories someone wrote. Semiont's Weaver is held beyond
them by `apps/weaver/tests/test_properties.py`: over histories a generator
makes, delivered in any order and some of them twice, its graph is what a
second fold, which shares nothing with it, says the record leaves.

- **`yield:created` puts the resource in the graph as its event records it:**
  its name, format, checksum and entity types from the payload, its storage
  URI where the payload has one, not archived; dated at the event's
  `timestamp`; and by the `wasAttributedTo` the payload records. The date is
  never the moment the Weaver applied the event, and who it is by is never
  made from who sent the event.
  *Held by `apps/weaver/tests/test_fold_cases.py` and `weaver/record`.*
- **A `yield:created` that records no `wasAttributedTo` is refused**
  ([What it has applied](#what-it-has-applied)).
  *Held by `apps/weaver/tests/test_fold_cases.py`.*
- **`mark:archived` and `mark:unarchived` set the resource's one flag.**
  *Held by `apps/weaver/tests/test_fold_cases.py` and `weaver/record`.*
- **`mark:added` puts the annotation in the graph under the id its event gave
  it, by the creator the event records.** The record's creator is the party
  that asked for the annotation. The event's own `userId` is the party that
  sent it, which for work a person asked a worker for is the worker's agent;
  the graph never takes a creator from it.
  *Held by `apps/weaver/tests/test_fold_cases.py` and `weaver/record`.*
- **A `mark:added` whose annotation records no creator is refused**
  ([What it has applied](#what-it-has-applied)).
  *Held by `apps/weaver/tests/test_fold_cases.py`.*
- **`mark:removed` takes the annotation out.** Removing one that is not there
  changes nothing.
  *Held by `apps/weaver/tests/test_fold_cases.py` and `weaver/record`.*
- **`mark:body-updated` applies its operations, in order, to the body the
  graph holds, and dates the annotation `modified` at the event's
  `timestamp`,** which is what the record's view does. `add` adds an item not
  already there; `remove` takes one out; `replace` puts one in another's
  place. An item is the same item as another of its type with the same
  `source`, or the same `value`.
  *Held by `apps/weaver/tests/test_fold_cases.py` and `weaver/record`.*
- **`mark:entity-tag-added` and `mark:entity-tag-removed` change the
  resource's entity types, which are a set.**
  *Held by `apps/weaver/tests/test_fold_cases.py` and `weaver/record`.*
- **`frame:entity-type-added` adds to the graph's vocabulary,** beside the
  entity types every knowledge base starts with.
  *Held by `apps/weaver/tests/test_fold_cases.py` and `weaver/record`.*

### What the graph holds

[`codec-cases.json`](../../specs/src/graph/codec-cases.json) states what is
stored of an annotation and of a resource, what each stored thing is called,
which are required, and what is refused.

- **Of an annotation:** its id, the resource it is on, its motivation, its
  selector as given, its creator, when it was made and last changed, and the
  software that made it; its link to another resource; and its entity tags.
  A body item that is neither a link nor a tag is not held.
  *Held by `packages/graph/src/__tests__/codec-cases.test.ts`, `packages/graph-python/tests/test_codec_cases.py`.*
- **A person is held as who they are, without a name.** A person's name is the
  directory's: the Archivist joins it onto every read, and a person can change
  it. *Held by `packages/graph/src/__tests__/codec-cases.test.ts`, `packages/graph-python/tests/test_codec_cases.py` and `weaver/record`.*
- **An update leaves the annotation the current one becomes with the changed
  fields replaced, and a store writes that whole:** a link or a tag the update
  took away goes with it. An annotation is never moved to another resource.
  *Held by `packages/graph/src/__tests__/codec-cases.test.ts`, `packages/graph-python/tests/test_codec_cases.py`.*
- **Of a resource:** its id, name, entity types, format, checksum, storage
  URI, whether it is archived, when the record says it was created, and who
  the record says it is by.
  *Held by `packages/graph/src/__tests__/codec-cases.test.ts`, `packages/graph-python/tests/test_codec_cases.py`.*
- **No store reads a clock.** Every date in the graph is one an event carried.
  *Held by `packages/graph-python/tests/test_census.py` and `scripts/compliance/audit-graph-annotation-codec.sh`.*

### Order

- **The events of one resource are applied one at a time, in the order of
  their sequence numbers.** *Held by `weaver/record`.*
- **The events of different resources are applied in no fixed order.** A link
  can reach the graph before the resource it points at, and the graph ends the
  same either way.
  *Held by `apps/weaver/tests/test_fold_cases.py` and `apps/weaver/tests/test_properties.py`.*
- **An event delivered again is applied once,** whether it comes again at
  once or after later ones.
  *Held by `apps/weaver/tests/test_fold_cases.py` and `apps/weaver/tests/test_properties.py`.*

## What it has applied

For each resource a Weaver keeps the sequence number it has applied up to.

- **It signals each advance on `weave:applied`,** with the resource and the
  sequence number. A reader of the graph waits on that signal to know the
  graph has caught up with something it just saw recorded.
  *Held by `weaver/record`.*
- **The mark only rises.**
  *Held by `weaver/record` and `apps/weaver/tests/test_properties.py`.*
- **The mark never reaches an event that was not applied.** An event the
  Weaver refuses, or fails to apply, is counted (`applyFailures` in its
  [health](#health)) and holds the mark below it, however many later events of
  the resource are applied. So what it missed is found again when it next
  starts. *Held by `apps/weaver/tests/test_fold_cases.py`.*
- **A refused event is refused alone.** The events delivered beside it are
  applied. *Held by `apps/weaver/tests/test_fold_cases.py`.*
- **It may keep its marks across a restart,** as a checkpoint. A checkpoint is
  never a correctness input: a Weaver with none applies the whole record again
  and ends with the same graph.
  *Held by `weaver/repair` and `apps/weaver/tests/test_properties.py`.*

## Boot

A Weaver starts in this order: it reads its settings; signs in; connects to
the graph database; subscribes to what it follows; opens its health port; runs
catch-up; runs reconcile.

- **It gives up when the gateway does not answer.** It tries to sign in a
  bounded number of times, then exits with a status other than 0, having said
  which address did not answer. *Held by `weaver/boot`.*
- **It gives up when the graph database does not answer** within its connect
  deadline. *Held by no case.*
- **Its health answers before catch-up begins,** and events recorded from then
  on are applied as they arrive, while the two passes run. *Held by no case.*
- **A pass that fails does not end the Weaver.** The failure is logged and
  reported in its [health](#health), and the Weaver goes on applying what
  arrives. *Held by no case.*

## Catch-up

Catch-up applies what was recorded while the Weaver was not running.

- **For every resource of the catalog, it reads the resource's events and
  applies those above its mark.** With a checkpoint that is what was recorded
  since; with none it is everything. *Held by `weaver/repair`.*
- **A mark above the last event the record holds means the record was
  rewound:** the resource is rebuilt ([Rebuild](#rebuild)).
  *Held by `apps/weaver/tests/test_weaver.py`.*
- **It reports** how many resources it checked (`resourcesChecked`), how many
  events it replayed (`eventsReplayed`), how many resources it rebuilt
  (`resourcesRebuilt`), how many events were not applied (`eventsFailed`) and
  how many resources had not reached their last event when it stopped waiting
  (`parityPending`). *Held by `weaver/boot` and `weaver/repair`.*

## Reconcile

Reconcile finds what catch-up cannot: a graph that no longer holds what the
Weaver once applied to it.

- **For every resource of the catalog, it compares the graph with the
  record,** and calls the resource divergent when: the graph has no such
  resource (`missing-node`); its archived flag differs (`archived-mismatch`);
  its entity types differ (`entity-types-mismatch`); the graph and the record
  do not hold the same annotations of it (`annotation-set-mismatch`); or an
  annotation in the graph is not what the graph is to hold of the record's
  (`annotation-content-mismatch`). *Held by `weaver/repair`.*
- **A graph the Weaver has just built is not divergent.** Whatever the record's
  read answers that the graph stores, the fold stored, and whatever the read
  adds of its own, the graph does not hold.
  *Held by `weaver/record`.*
- **A divergent resource is healed by rebuilding it from the record**
  ([Rebuild](#rebuild)), and is dated and attributed afterwards as it was
  before. *Held by `weaver/repair`.*
- **A resource the catalog lists and the record holds no events for is an
  orphaned view.** It is counted, and not healed: there is nothing to rebuild
  it from. *Held by `apps/weaver/tests/test_weaver.py`.*
- **A graph that was cleared is rebuilt whole** by this pass, when the Weaver
  next starts. *Held by `weaver/repair`.*
- **It reports** how many resources it checked (`resourcesChecked`), how many
  were divergent (`divergent`), healed (`healed`), not healed because events
  were not applied (`healFailures`), and orphaned (`orphaned`).
  *Held by `weaver/boot` and `weaver/repair`.*

## Rebuild

- **`weave:rebuild` naming a resource rebuilds that resource:** the graph loses
  the resource and the annotations on it, and the resource's events are
  applied again, in order. *Held by `weaver/repair`.*
- **Another resource's annotation that links to the rebuilt one is not
  touched,** and is followed to it afterwards as before.
  *Held by `weaver/repair` and `apps/weaver/tests/test_weaver.py`.*
- **`weave:rebuild` naming none rebuilds the whole graph:** the graph is
  cleared, its vocabulary kept, and every resource of the catalog applied
  again. *Held by `weaver/repair` and `apps/weaver/tests/test_properties.py`.*
- **It answers `weave:rebuild-ok` when every event was applied, and
  `weave:rebuild-failed`, saying how many were not, otherwise.**
  *Held by `weaver/repair` and `apps/weaver/tests/test_weaver.py`.*

## Health

- **`GET /health` answers `200` with a JSON object:** `status`; `applyFailures`,
  the number of events it could not apply since it started; and `catchUp` and
  `reconcile`, each a `phase` (`pending`, `running`, `done` or `failed`) with
  the pass's `summary` when it is done, or its `error` when it failed.
  *Held by `weaver/boot`.*
- **`status` is `ok` whenever the Weaver answers.** It says nothing of whether
  the Weaver can reach the gateway or the graph. *Held by no case.*

## Stopping

- **On SIGTERM a Weaver stops applying, closes what it holds open, and exits
  with status 0.** *Held by `weaver/boot`.*

## Telemetry

- **A Weaver started with `OTEL_EXPORTER_OTLP_ENDPOINT` exports, as
  `semiont-weaver`, exactly what
  [`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json)
  lists for the weaver, and the rows of
  [`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json)
  the first names for it under `sdk`.** Those are what every service says of
  its own process (when it started, how late its loop runs, its memory), a
  span for each frame it sends and each it receives on the bus, and a count
  of the frames it sent. Every span and metric it exports is one of those
  rows, of the row's kind, carrying only the row's attributes; and every one
  of those rows that its work can make arrives, with every attribute the row
  does not mark as conditional. *Held by `weaver/telemetry`.*
- **An event it logs while a span is current carries that span's trace and
  its own id** (`trace_id` and `span_id`), in either form of its log. One
  logged in no span carries neither.
  *Held by `apps/weaver/tests/test_log.py`.*

## Environment

A Weaver's own code reads these from its environment, beside its document,
and no others:

| Variable | What it is |
|---|---|
| `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` | Its service account at the knowledge base's issuer. Required |
| the variable its document names | The graph database's password. Required. A stack the launcher starts names `NEO4J_PASSWORD`, and gives it the password the launcher keeps |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The OTLP/HTTP collector its spans and metrics are exported to ([Telemetry](#telemetry)). Without it, and without the console exporter, it exports nothing and writes no span or metric anywhere |
| `OTEL_SERVICE_NAME` | The `service.name` its spans and metrics carry; `semiont-weaver` when unset or empty |
| `OTEL_SDK_DISABLED` | Set to `true`, it exports nothing, whatever else is set |
| `OTEL_CONSOLE_EXPORTER` | Set to `true`, with no endpoint, it writes spans and metrics to its output instead of exporting them |
| `OTEL_METRICS_EXPORTER` | Set to `console`, it writes metrics to its output, while spans still go to the endpoint |
| `OTEL_METRIC_EXPORT_INTERVAL` | The milliseconds between metric exports; 30000 when unset |
| `SUPERVISE_EVENTS`, `SUPERVISE_NAME` | The supervisor's events log, one `starting <name>` line for each life of the process, and that name. With both, it reports `semiont.process.restarts`: the lives the log records, less one. Without either, the metric does not exist |

The libraries it is built on read some unasked. Its OpenTelemetry SDK and
exporter read the standard variables they read on their own, such as how long
a finished span waits to be exported (`OTEL_BSP_SCHEDULE_DELAY`), but none
that would say where its telemetry goes or the name it goes under. Semiont's
SDK reads `SEMIONT_BUS_LOG`, and with any value that is not empty writes a
line to the service's output for each frame it sends and receives.

What each telemetry variable does is what the Worker service's does
([WORKER-SERVICE.md](./WORKER-SERVICE.md#environment)): the Weaver's code for
it is the Worker's, held to it by `apps/weaver/tests/test_census.py`.

*Held by `weaver/boot`, `weaver/telemetry` and `apps/weaver/tests/test_census.py`.*

## Not specified here

- **Telemetry of its own work.** No row of the telemetry table is of what a
  Weaver applies, fails to apply, heals or rebuilds: its health says those,
  and it exports no span or metric of them.
- **Events it does not follow.** `yield:cloned`, `yield:updated`,
  `yield:moved`, `yield:representation-added` and
  `yield:representation-removed` change what a view holds of a resource, and
  the graph is not told: a moved resource's storage URI in the graph is the
  old one.
- **A body update that fails.** A `mark:body-updated` whose annotation the
  graph does not hold is passed by, and counted as applied.
