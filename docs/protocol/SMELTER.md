# Smelter

What the Smelter does: the process a smelter image runs. It keeps two stores
in step with the record: a vector index, which the Librarian searches, and a
store of anchored text, which the Archivist serves. It follows the recorded
events that change what either holds. For a resource it reads the bytes, gets
their text, cuts it into chunks, has each chunk embedded and puts them in the
index, and says what it decided. For an annotation it embeds the text the
annotation quotes. When it starts, it repairs what it missed and what either
store lost. What the record is, and what the Archivist answers, is
[ARCHIVIST.md](./ARCHIVIST.md); what the bus carries is
[EVENT-BUS.md](./EVENT-BUS.md).

A Smelter written in another language does what is written here. If the code
deviates from it, the code is wrong, or this document is wrong and is
corrected deliberately. There is no third option.

**How this document is held.** Each rule ends with *Held by* and what fails
when a Smelter breaks it. `smelter/<case>` is the file `<case>.test.ts` of the
smelter conformance suite
([`tests/conformance/smelter`](../../tests/conformance/smelter/README.md)),
which starts a Smelter as a process behind a real gateway and a real
Archivist, records through the Archivist, plays its embedding provider, and
reads the index back from a real database: the same cases judge every
implementation. A path names a test. Some are runners of a case table, which
every implementation runs through its own code:
[`specs/src/vectors/payload-cases.json`](../../specs/src/vectors/payload-cases.json)
and
[`specs/src/vectors/store-cases.json`](../../specs/src/vectors/store-cases.json),
what a point of the index is and what the index answers;
[`specs/src/smelter/reconcile-cases.json`](../../specs/src/smelter/reconcile-cases.json),
the work a start plans;
[`specs/src/smelter/extraction-cases.json`](../../specs/src/smelter/extraction-cases.json),
what each kind of PDF becomes; and
[`specs/src/text/chunk-cases.json`](../../specs/src/text/chunk-cases.json),
how a text is cut. The others are tests of Semiont's own Smelter. A rule
marked "Held by no case" is one nothing checks.
`npm run lint:transport-contract` fails when a case or a test named here does
not exist, and when a case of the suite is named by no rule.

**Both stores are projections, and not copies.** The record is the system of
record: every point of the index and every entry of the anchored-text store
can be made again from the record and the bytes it holds. Either store can be
cleared, and a Smelter that starts afterwards fills it again.

## Settings

A Smelter is told: the gateway's URL; the issuer its service account signs in
at; where the Archivist is, for a resource's bytes; the vector database (its
kind, and its host and port); the embedding provider (its kind, its model and
its address); the two numbers a text is cut by, a chunk's size and how far
one chunk overlaps the next; and the directory of the anchored-text store.
Semiont's Smelter reads them from the knowledge base's configuration file,
where the database's port and the two numbers may be left out, and are then
6333, 512 and 64. The directory it reads from its environment
([Environment](#environment)).

- **Without the gateway's URL, the issuer, the Archivist's address, the
  vector database's host, or the embedding provider's kind, model or address,
  it refuses to start,** and says which is missing. *Held by `smelter/boot`.*
- **Its service account is `SEMIONT_OIDC_CLIENT_ID` and
  `SEMIONT_OIDC_CLIENT_SECRET` in its environment.** With either missing it
  refuses to start, and names what is missing. *Held by `smelter/boot`.*
- **The anchored-text store's directory has no default.** With
  `SEMIONT_ANCHORED_TEXT_DIR` unset it refuses to start, and names the
  variable. *Held by `smelter/boot`.*

## What it follows

A Smelter signs in as its service account and works as an agent named by its
embedding provider and its model, so that two Smelters that embed with
different models are different agents. It reaches the record through the
gateway, and reads bytes from the Archivist.

- **It follows nine recorded events:** `yield:created`, `yield:updated`,
  `yield:representation-added`, `mark:archived`, `mark:unarchived`,
  `mark:added`, `mark:removed`, `mark:entity-tag-added` and
  `mark:entity-tag-removed`.
  *Held by `packages/make-meaning/src/__tests__/smelter-fan-in.test.ts`.*
- **It reads what the record holds from the Archivist, over the bus:** a
  resource's description (`browse:resource-requested`), a resource's
  annotations (`browse:annotations-requested`), and the catalog of resources
  that are not archived (`browse:resources-requested`, 200 to a page). It
  opens no file of the record.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts`.*
- **It reads a resource's bytes from the Archivist's own
  `GET /resources/{id}/content`, as its service account, and takes them as
  they are stored.** The checksum it works by is of exactly those bytes.
  *Held by no case.*
- **It answers one command,** `smelt:rebuild-anchors` ([Rebuild](#rebuild)),
  **and emits one signal,** `smelt:settled`
  ([What it decides](#what-it-decides)).
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts`.*
- **It writes the vector index and the anchored-text store, and nothing
  else.** It records nothing: no event is its. *Held by no case.*

## What each event does

A Smelter takes from an event which resource or annotation changed. What a
resource's points are made of it reads afresh: the resource's bytes, and its
entity types from its description as the Archivist answers it then.

- **`yield:created`, `yield:updated` and `yield:representation-added` index
  the resource** ([Indexing a resource](#indexing-a-resource)).
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **Nothing in such an event's payload changes what is indexed.**
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`.*
- **`mark:archived` takes the resource's points out of the index, and the
  points of every annotation on it.**
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **`mark:unarchived` indexes the resource, and then each annotation the
  Archivist answers for it,** so that an unarchived resource is found again
  without a restart.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **`mark:added` indexes the annotation the event carries**
  ([Indexing an annotation](#indexing-an-annotation)).
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **`mark:removed` takes the annotation's point out.** Removing one that is
  not there changes nothing.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **`mark:entity-tag-added` and `mark:entity-tag-removed` rewrite the entity
  types on the resource's points to the resource's entity types as they now
  are, and ask nothing of the embedding provider.** A resource with no points
  is left with none: its entity types are written when it is next indexed.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts`, `packages/vectors/src/__tests__/store-cases.test.ts` and `smelter/index`.*

### Indexing a resource

- **It reads the resource's bytes and takes their checksum before it decides
  anything,** so that whatever it decides is said of those bytes.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **The resource's media type says where its text comes from**
  ([`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json)):
  decoded from the bytes, derived from a PDF ([A PDF's text](#a-pdfs-text)),
  or nowhere. A `text/` type the registry does not list is decoded.
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts` and `smelter/index`.*
- **Decoded text is the text the protocol says those bytes are**
  ([W3C-SELECTORS.md](./W3C-SELECTORS.md#the-text-of-a-resource)).
  *Held by `packages/core/src/__tests__/decode-cases.test.ts`.*
- **The text is cut into chunks as
  [`chunk-cases.json`](../../specs/src/text/chunk-cases.json) states,** by
  the two numbers of its settings.
  *Held by `packages/core/src/__tests__/chunk-cases.test.ts` and `smelter/index`.*
- **Every chunk is embedded before any point is written.** A resource whose
  chunks could not all be embedded keeps the points it had.
  *Held by `smelter/index`.*
- **The resource's points are then replaced by the new ones, all of them.** A
  resource whose text grew shorter keeps no point of the longer text.
  *Held by `packages/vectors/src/__tests__/store-cases.test.ts` and `smelter/index`.*
- **Each point carries the chunk's text and its place among the chunks, the
  checksum of the bytes, the resource's entity types, and a mark when the
  text was read from pixels,** as
  [`payload-cases.json`](../../specs/src/vectors/payload-cases.json) states.
  *Held by `packages/vectors/src/__tests__/payload-cases.test.ts` and `smelter/index`.*
- **Only a resource whose bytes gave text has points.**
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts` and `smelter/index`.*

### Indexing an annotation

- **An annotation's point is the embedding of the text its target quotes,**
  with the annotation's id, its resource, its motivation, its entity types
  and that text, as
  [`payload-cases.json`](../../specs/src/vectors/payload-cases.json) states.
  *Held by `packages/vectors/src/__tests__/payload-cases.test.ts` and `smelter/index`.*
- **An annotation that quotes no text, or only white space, has no point.**
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts` and `smelter/index`.*
- **An annotation on a resource whose text was read from pixels carries the
  same mark,** read from the resource's points and not worked out again.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts`.*

### Order

- **The events of one resource are applied one at a time, in the order they
  arrive.**
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`.*
- **The events of different resources are applied in no fixed order,** and
  the index ends the same either way.
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`.*
- **An event delivered twice in a row changes nothing the second time.**
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`.*
- **An event that fails is logged and passed by.** The events of other
  resources are applied, and what was missed is found when the Smelter next
  starts ([Reconcile](#reconcile)).
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`, `smelter/index` and `smelter/provider`.*
- **The work a start plans, and a rebuild's, takes its turn among a
  resource's events as an event does.** So it never puts back what a later
  event changed.
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`.*

## What it decides

For each resource it is asked to index, a Smelter decides one of two things
and says so.

- **It signals every decision on `smelt:settled`:** the resource, the
  checksum of the bytes it read, and `indexed` or `skipped`. A reader waits
  on that signal to know the Smelter has done with bytes it just saw
  recorded.
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`, `smelter/index` and `smelter/pdf`.*
- **`indexed` is signalled once the points are written.**
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **`skipped` carries its reason,** one of six: `no-extractor`, the media
  type has no text; `empty`, the text is nothing but white space;
  `no-text-layer`, `encrypted`, `corrupt` and `too-large`, the ways a PDF is
  declined ([A PDF's text](#a-pdfs-text)).
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts`, `smelter/index` and `smelter/pdf`.*
- **A skipped resource has no points.** Points made from bytes it had before
  are taken out.
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`, `smelter/index` and `smelter/pdf`.*
- **Every skip is logged as a warning, with the resource, the reason, the
  media type and the checksum.** A resource is never left out of the index
  without a line that says so.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/index`.*
- **Bytes it could not read are not a decision.** Nothing is signalled, the
  index is not changed, and the failure is logged. Whoever waits is left to
  the end of its own wait.
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts` and `smelter/index`.*
- **A signal that cannot be sent does not undo what was indexed.**
  *Held by no case.*

## A PDF's text

A PDF's text is derived, and comes with where each run of it is on a page.
[`extraction-cases.json`](../../specs/src/smelter/extraction-cases.json)
states what each kind of document becomes.

- **A document with a text layer of its own is read from that layer,** run by
  run, each with its place on its page.
  *Held by `packages/content/src/__tests__/extraction-cases.test.ts` and `smelter/pdf`.*
- **A scanned document is read from its pixels:** each page's images are
  taken out and read by OCR, and each word is placed on the page by the place
  of the image it was read from. No fixture of the table has a word in its
  pixels, so the table holds only that a scan in which nothing can be read is
  declined; the tests named here play the OCR engine.
  *Held by `packages/content/src/__tests__/pdf-ocr.test.ts` and `packages/content/src/__tests__/pdf-placement.test.ts`.*
- **A document with pages of each kind is read both ways,** and names the
  pages that could not be read.
  *Held by `packages/content/src/__tests__/extraction-cases.test.ts` and `packages/content/src/__tests__/pdf-ocr.test.ts`.*
- **A page that is a grid of cells is written as rows,** each row's cells on
  one line, in their order.
  *Held by `packages/content/src/__tests__/extraction-cases.test.ts`.*
- **A filled form's values are part of its text.**
  *Held by `packages/content/src/__tests__/extraction-cases.test.ts`.*
- **A document that cannot be parsed, or that is larger than 200 MB, is
  declined, by name,** and one too large is declined before anything parses
  it. A scanned document in which nothing can be read is declined as having
  no text layer.
  *Held by `packages/content/src/__tests__/extraction-cases.test.ts` and `smelter/pdf`.*
- **An encrypted document is declined, by name.** No fixture is encrypted.
  *Held by `packages/content/src/__tests__/pdf-extractor.test.ts`.*
- **The outcome says how the text was got** (its `method`), and text read by
  OCR is marked on every point made from it.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/pdf`.*

### The anchored-text store

- **The Smelter is the store's only writer.** The Archivist reads it, and
  answers a resource's anchored text from it
  ([ARCHIVIST.md](./ARCHIVIST.md#the-http-surface)). *Held by `smelter/pdf`.*
- **What deriving a PDF's text came to is stored under the checksum of the
  bytes, a decline as well as a text,** as an
  [`AnchoredTextEntry`](../../specs/src/components/schemas/AnchoredTextEntry.json).
  *Held by `packages/content/src/__tests__/anchored-text-cache.test.ts` and `smelter/pdf`.*
- **The entry is stored before the decision is signalled,** so whoever hears
  that content was settled finds its entry.
  *Held by `smelter/pdf`.*
- **Text that has no places on a page has no entry.**
  *Held by `packages/make-meaning/src/__tests__/smelter-anchored-text.test.ts` and `smelter/pdf`.*
- **Bytes whose outcome is stored are not derived again:** the stored outcome
  is what is indexed.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `packages/content/src/__tests__/anchored-text-cache.test.ts`.*
- **An entry that cannot be written does not stop the resource being
  indexed.** The entry is found missing when the Smelter next starts
  ([Reconcile](#reconcile)).
  *Held by `packages/make-meaning/src/__tests__/smelter-anchored-text.test.ts` and `smelter/pdf`.*
- **The writer states its stamp:** the store's directory holds a file,
  `STAMP`, with the stamp its entries carry, and a reader takes no entry
  under another, nor one of another version of the entry's form. An entry
  made by a Smelter that derives text another way is then a miss, and is
  derived again.
  *Held by `packages/content/src/__tests__/anchored-text-cache.test.ts` and `smelter/pdf`.*

## The index

- **The index is two collections of points,** one of resources' chunks and one
  of annotations, searched by cosine similarity.
  [`payload-cases.json`](../../specs/src/vectors/payload-cases.json) states
  what a point of each holds, and what is indexed for a filter.
  *Held by `packages/vectors/src/__tests__/payload-cases.test.ts`.*
- **A collection is as wide as the embedding model's vectors,** which the
  Smelter learns by asking the provider to embed once, when it first makes
  the collection.
  *Held by `packages/vectors/src/__tests__/payload-cases.test.ts`.*
- **What a search of the index answers is what
  [`store-cases.json`](../../specs/src/vectors/store-cases.json) states.**
  *Held by `packages/vectors/src/__tests__/store-cases.test.ts`.*

## The embedding provider

A Smelter asks one provider for its vectors: an Ollama
(`POST <address>/api/embed`, with the model and a list of texts), or Voyage
(`POST https://api.voyageai.com/v1/embeddings`, with a bearer key).

- **A batch of texts is cut into slices of 128, each one request, made in
  the order of the texts,** and the vectors are given back in that order.
  *Held by `packages/vectors/src/__tests__/embed-batch-slicing.test.ts` and `smelter/provider`.*
- **Each request has 15 seconds of its own,** counted from when it is sent
  and not from when its batch began.
  *Held by `packages/vectors/src/__tests__/embed-batch-slicing.test.ts`.*
- **One request at a time is made of an Ollama, and four of Voyage,** however
  many resources are being indexed.
  *Held by `packages/vectors/src/__tests__/embed-batch-slicing.test.ts` and `smelter/provider`.*
- **A request that fails fails its whole batch, and says which provider,
  which model, what status and which slice.** The resource it was for gets no
  points from that attempt.
  *Held by `packages/vectors/src/__tests__/embed-batch-slicing.test.ts`, `packages/vectors/src/__tests__/cold-embedding-model.test.ts` and `smelter/provider`.*
- **A provider that answers 404 when the Smelter starts is taken to be still
  fetching the model, and one that cannot be reached to be still starting:
  either is asked again,** up to twelve times, within the time the Smelter
  has to start ([Boot](#boot)). An answer of any other failing status is not
  asked again.
  *Held by `packages/vectors/src/__tests__/cold-embedding-model.test.ts` and `smelter/boot`.*

## Boot

A Smelter starts in this order: it reads its settings; signs in; reaches its
embedding provider and its vector database; subscribes to what it follows;
opens its health port; runs reconcile.

- **It gives up when the embedding provider or the vector database does not
  answer within a minute,** and exits with a status other than 0.
  *Held by no case.*
- **Its health answers before reconcile begins,** and events recorded from
  then on are applied as they arrive, while reconcile runs.
  *Held by `smelter/boot`.*
- **A reconcile that fails does not end the Smelter.** The failure is logged
  and reported in its [health](#health), and the Smelter goes on applying
  what arrives.
  *Held by `packages/make-meaning/src/__tests__/boot-pass.test.ts` and `packages/make-meaning/src/__tests__/smelter.test.ts`.*

## Reconcile

Reconcile finds what the Smelter missed while it was not running, and what
either store has lost. It compares three things: what the index holds, what
the catalog says the knowledge base holds, and which bytes the anchored-text
store has an entry for.
[`reconcile-cases.json`](../../specs/src/smelter/reconcile-cases.json) states
the work it plans for each difference, and is the rule; this section says it
in prose.

- **It reads the index before it reads the catalog,** so that a resource
  indexed while it runs is never taken for one that should not be there.
  *Held by no case.*
- **A resource of the catalog whose media type has text, and which has no
  points, is indexed.**
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts` and `smelter/reconcile`.*
- **One whose points carry another checksum than the catalog states is
  indexed again.**
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts` and `smelter/reconcile`.*
- **One whose points carry the catalog's checksum and other entity types has
  its entity types rewritten, and nothing is embedded.**
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts`, `packages/make-meaning/src/__tests__/smelter-axioms.test.ts` and `smelter/reconcile`.*
- **One whose points carry the catalog's checksum, whose text has places on a
  page, and whose bytes the anchored-text store has no entry for, has its
  anchored text derived again,** from the bytes as they now are, and filed
  under their checksum. Nothing is embedded, the index is not touched, and
  nothing is signalled.
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts`, `packages/make-meaning/src/__tests__/smelter-axioms.test.ts` and `smelter/reconcile`.*
- **Points of a resource that is none of the catalog's resources with text
  are taken out:** one that is archived, one that is gone, one whose media
  type has no text.
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts` and `smelter/reconcile`.*
- **An annotation that quotes text, on any resource of the catalog, and has
  no point is indexed; a point whose annotation is not among them is taken
  out.**
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts` and `smelter/reconcile`.*
- **Where it plans to index a resource and an annotation on it, the resource
  comes first,** since an annotation's point takes its mark of text read from
  pixels from the resource's points as they then are. The rest of the work is
  in no stated order.
  *Held by `packages/make-meaning/src/__tests__/reconcile-cases.test.ts` and `smelter/reconcile`.*
- **The work is done at most eight items at a time,** each in its turn among
  its resource's events ([Order](#order)). *Held by no case.*
- **An index that was cleared is filled again whole** by this pass, when the
  Smelter next starts. So is an anchored-text store that was cleared.
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts` and `smelter/reconcile`.*
- **It reports** what the resources it set out to index came to: how many
  were indexed (`resourcesEmbedded`), skipped, by reason
  (`resourcesSkipped`), unread (`resourcesUnavailable`), and failed
  (`resourcesFailed`); how many it planned to rewrite the entity types of
  (`resourcesRestamped`), to derive the anchored text of again
  (`resourcesReanchored`) and to take out (`resourceVectorsDeleted`); how
  many annotations it planned to index (`annotationsEmbedded`) and to take
  out (`annotationVectorsDeleted`); and how many resources of the catalog
  have text (`resourcesEligible`) and how many have points when it ends
  (`resourcesIndexed`).
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts`, `smelter/boot` and `smelter/reconcile`.*

## Rebuild

- **`smelt:rebuild-anchors` naming a resource derives that resource's
  anchored text where the store has no entry for its bytes; naming none, that
  of every resource of the catalog whose text has places on a page.** A
  document that is declined is done, and its decline is what is stored. A
  resource named that has no such text is done, with nothing derived.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/pdf`.*
- **Nothing is deleted first, and an entry that is there is kept.** So a
  rebuild that fails part way has lost nothing. *Held by `smelter/pdf`.*
- **Nothing is embedded, and the index is not touched.**
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/pdf`.*
- **Rebuilds are done one at a time, and never while the work of reconcile
  is being done:** of a rebuild and a reconcile, the one whose work is ready
  first is done first, and the other waits. *Held by no case.*
- **It answers `smelt:rebuild-anchors-ok` when every resource was done, and
  `smelt:rebuild-anchors-failed`, saying how many of how many were not,
  otherwise.** The ones that could be done are done.
  *Held by `packages/make-meaning/src/__tests__/smelter.test.ts` and `smelter/pdf`.*

## Health

- **`GET /health` on port 24101 answers `200` with a JSON object:** `status`;
  `eventsProcessed`, the number of events it has applied since it started;
  and `reconcile`, a `phase` (`pending`, `running`, `done` or `failed`) with
  the pass's `summary` when it is done, or its `error` when it failed.
  *Held by `smelter/boot`.*
- **The work of reconcile and of a rebuild is not counted among the events
  processed.**
  *Held by `packages/make-meaning/src/__tests__/smelter-axioms.test.ts`, `smelter/boot` and `smelter/reconcile`.*
- **`status` is `ok` whenever the Smelter answers.** It says nothing of
  whether the Smelter can reach the gateway, its provider or its index.
  *Held by no case.*

## Stopping

- **On SIGTERM a Smelter stops applying, closes what it holds open, and exits
  with status 0.** *Held by `smelter/boot`.*

## Telemetry

- **A Smelter started with `OTEL_EXPORTER_OTLP_ENDPOINT` exports, as
  `semiont-smelter`:** a span for each frame it sends and each it receives on
  the bus; a span for each event, or burst of one resource's events, it
  applies; the number of points its index holds
  (`semiont.vector.index.size`); and what every service says of its own
  process. *Held by no case.*

## Environment

A Smelter's own code reads these from its environment, and no others:

| Variable | What it is |
|---|---|
| `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` | Its service account at the knowledge base's issuer. Required |
| `SEMIONT_ANCHORED_TEXT_DIR` | The directory of the anchored-text store. Required |
| any variable its configuration file names | The file may give a value as `${NAME}`, and is read with it filled in |
| the telemetry variables | Where its spans and metrics go and under what name ([Telemetry](#telemetry)) |
| `LOG_LEVEL`, `LOG_FORMAT` | How much it logs (`info` when unset), and in what form: `simple` for lines a person reads, and JSON otherwise |
| `SUPERVISE_EVENTS`, `SUPERVISE_NAME` | The supervisor's events log and the name it runs the Smelter under, from which it reports how many times it has been started again |

*Held by no case.*

## Not specified here

- **What made a point.** A point names neither the embedding model nor the
  two numbers its text was cut by. What becomes of an index when any of the
  three changes is not stated here.
- **An annotation's entity types, after it is indexed.** A point holds the
  entity types its annotation had then. `mark:body-updated` is not followed.
- **Events it does not follow.** `yield:cloned` records a new resource, and
  `yield:moved` and `yield:representation-removed` change one; the index is
  not told of any of them as it happens. A copy is indexed when the Smelter
  next starts.
- **What reconcile's counts mean when work fails.** The four counts of what
  the resources it set out to index came to are outcomes. The other counts
  are of what was planned.
- **Telemetry of its own decisions.** No span or metric says what a Smelter
  indexed, skipped or failed on: its log and its health do.
