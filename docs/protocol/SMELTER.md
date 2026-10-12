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

A Smelter reads its settings from a configuration document, the protocol's
[`SmelterConfig`](../../specs/src/components/schemas/SmelterConfig.json), at
the path its `--config` flag names. The document is resolved: no `${VAR}` is
left in it, and the Smelter defaults nothing it leaves out. It states the
gateway's URL; the issuer the Smelter's service account signs in at; where
the Archivist is, for a resource's bytes; the embedding provider
([`EmbeddingConfig`](../../specs/src/components/schemas/EmbeddingConfig.json):
its kind, its model and where it is reached, with the name of the environment
variable that holds its key, for a provider that takes one); the vector index
([`VectorsConfig`](../../specs/src/components/schemas/VectorsConfig.json): its
kind, and what that kind needs to be reached); the two numbers a text is cut
by, a chunk's size and how far one chunk overlaps the next; the directory of
the anchored-text store; the port its health answers on; and how it logs.
Whoever starts a Smelter writes it: the launcher for the Smelter it starts,
and anyone else to the same schema.

- **Started with no `--config`, with a path it cannot read, or with a document
  that is not the schema's, it refuses to start,** and says which. A refusal
  names a member of the document and what was expected of it, and never a
  value found there. *Held by `apps/smelter/tests/test_service.py`.*
- **Without the gateway's URL, the issuer, the Archivist's address, the
  vector database's host, the embedding provider's kind, model or address, or
  the directory of the anchored-text store, it refuses to start,** and names
  the member that is missing. *Held by `apps/smelter/tests/test_service.py` and `smelter/boot`.*
- **An index that lives in one process's memory is refused.** Nothing else
  could search it. *Held by `apps/smelter/tests/test_service.py`.*
- **Its service account is `SEMIONT_OIDC_CLIENT_ID` and
  `SEMIONT_OIDC_CLIENT_SECRET` in its environment** ([Environment](#environment)).
  With either missing it refuses to start, and names what is missing.
  *Held by `apps/smelter/tests/test_service.py` and `smelter/boot`.*
- **An embedding provider's key is read from the variable its document
  names.** With that variable unset it refuses to start, and names the
  variable. *Held by `apps/smelter/tests/test_service.py`.*

## What it follows

A Smelter signs in as its service account and works as an agent named by its
embedding provider and its model, so that two Smelters that embed with
different models are different agents. It reaches the record through the
gateway, and reads bytes from the Archivist.

- **It follows nine recorded events:** `yield:created`, `yield:updated`,
  `yield:representation-added`, `mark:archived`, `mark:unarchived`,
  `mark:added`, `mark:removed`, `mark:entity-tag-added` and
  `mark:entity-tag-removed`.
  *Held by `apps/smelter/tests/test_census.py`.*
- **It reads what the record holds from the Archivist, over the bus:** a
  resource's description (`browse:resource-requested`), a resource's
  annotations (`browse:annotations-requested`), and the catalog of resources
  that are not archived (`browse:resources-requested`, 200 to a page). It
  opens no file of the record.
  *Held by `apps/smelter/tests/test_smelter.py` and `packages/service-python/tests/test_catalog.py`.*
- **It reads a resource's bytes from the Archivist's own
  `GET /resources/{id}/content`, as its service account, and takes them as
  they are stored.** The checksum it works by is of exactly those bytes.
  *Held by `packages/service-python/tests/test_archivist.py`.*
- **It answers one command,** `smelt:rebuild-anchors` ([Rebuild](#rebuild)),
  **and emits one signal,** `smelt:settled`
  ([What it decides](#what-it-decides)).
  *Held by `apps/smelter/tests/test_smelter.py`.*
- **It writes the vector index and the anchored-text store, and nothing
  else.** It records nothing: no event is its. *Held by no case.*

## What each event does

A Smelter takes from an event which resource or annotation changed. What a
resource's points are made of it reads afresh: the resource's bytes, and its
entity types from its description as the Archivist answers it then.

- **`yield:created`, `yield:updated` and `yield:representation-added` index
  the resource** ([Indexing a resource](#indexing-a-resource)).
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **Nothing in such an event's payload changes what is indexed.**
  *Held by `apps/smelter/tests/test_smelter.py` and `apps/smelter/tests/test_properties.py`.*
- **`mark:archived` takes the resource's points out of the index, and the
  points of every annotation on it.**
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **`mark:unarchived` indexes the resource, and then each annotation the
  Archivist answers for it,** so that an unarchived resource is found again
  without a restart.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **`mark:added` indexes the annotation the event carries**
  ([Indexing an annotation](#indexing-an-annotation)).
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **`mark:removed` takes the annotation's point out.** Removing one that is
  not there changes nothing.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **`mark:entity-tag-added` and `mark:entity-tag-removed` rewrite the entity
  types on the resource's points to the resource's entity types as they now
  are, and ask nothing of the embedding provider.** A resource with no points
  is left with none: its entity types are written when it is next indexed.
  *Held by `packages/vectors-python/tests/store_contract.py`, `apps/smelter/tests/test_smelter.py` and `smelter/index`.*

### Indexing a resource

- **It reads the resource's bytes and takes their checksum before it decides
  anything,** so that whatever it decides is said of those bytes.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **The resource's media type says where its text comes from**
  ([`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json)):
  decoded from the bytes, derived from a PDF ([A PDF's text](#a-pdfs-text)),
  or nowhere. A `text/` type the registry does not list is decoded.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **Decoded text is the text the protocol says those bytes are**
  ([W3C-SELECTORS.md](./W3C-SELECTORS.md#the-text-of-a-resource)).
  *Held by `packages/sdk-python/tests/test_decode_cases.py`, for the reader the Smelter decodes with.*
- **The text is cut into chunks as
  [`chunk-cases.json`](../../specs/src/text/chunk-cases.json) states,** by
  the two numbers of its settings.
  *Held by `apps/smelter/tests/test_chunk_cases.py` and `smelter/index`.*
- **Every chunk is embedded before any point is written.** A resource whose
  chunks could not all be embedded keeps the points it had.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **The resource's points are then replaced by the new ones, all of them.** A
  resource whose text grew shorter keeps no point of the longer text.
  *Held by `packages/vectors-python/tests/store_contract.py`, `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **Each point carries the chunk's text and its place among the chunks, the
  checksum of the bytes, the resource's entity types, and a mark when the
  text was read from pixels,** as
  [`payload-cases.json`](../../specs/src/vectors/payload-cases.json) states.
  *Held by `packages/vectors-python/tests/test_payload_cases.py`, `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **Only a resource whose bytes gave text has points.**
  *Held by `apps/smelter/tests/test_properties.py`, `apps/smelter/tests/test_smelter.py` and `smelter/index`.*

### Indexing an annotation

- **An annotation's point is the embedding of the text its target quotes,**
  with the annotation's id, its resource, its motivation, its entity types
  and that text, as
  [`payload-cases.json`](../../specs/src/vectors/payload-cases.json) states.
  *Held by `packages/vectors-python/tests/test_payload_cases.py`, `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **An annotation that quotes no text, or only white space, has no point.**
  *Held by `apps/smelter/tests/test_reconcile_cases.py`, `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **An annotation on a resource whose text was read from pixels carries the
  same mark,** read from the resource's points and not worked out again.
  *Held by `apps/smelter/tests/test_smelter.py`.*

### Order

- **The events of one resource are applied one at a time, in the order they
  arrive.**
  *Held by `apps/smelter/tests/test_smelter.py` and `packages/service-python/tests/test_lanes.py`.*
- **The events of different resources are applied in no fixed order,** and
  the index ends the same either way.
  *Held by `apps/smelter/tests/test_properties.py` and `apps/smelter/tests/test_smelter.py`.*
- **An event delivered twice in a row changes nothing the second time.**
  *Held by `apps/smelter/tests/test_properties.py` and `apps/smelter/tests/test_smelter.py`.*
- **An event that fails is logged and passed by.** The events of other
  resources are applied, and what was missed is found when the Smelter next
  starts ([Reconcile](#reconcile)).
  *Held by `apps/smelter/tests/test_smelter.py`, `smelter/index` and `smelter/provider`.*
- **The work a start plans, and a rebuild's, takes its turn among a
  resource's events as an event does.** So it never puts back what a later
  event changed.
  *Held by `apps/smelter/tests/test_properties.py` and `apps/smelter/tests/test_smelter.py`.*

## What it decides

For each resource it is asked to index, a Smelter decides one of two things
and says so.

- **It signals every decision on `smelt:settled`:** the resource, the
  checksum of the bytes it read, and `indexed` or `skipped`. A reader waits
  on that signal to know the Smelter has done with bytes it just saw
  recorded.
  *Held by `apps/smelter/tests/test_smelter.py`, `apps/smelter/tests/test_properties.py`, `smelter/index` and `smelter/pdf`.*
- **`indexed` is signalled once the points are written.**
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **`skipped` carries its reason,** one of six: `no-extractor`, the media
  type has no text; `empty`, the text is nothing but white space;
  `no-text-layer`, `encrypted`, `corrupt` and `too-large`, the ways a PDF is
  declined ([A PDF's text](#a-pdfs-text)).
  *Held by `apps/smelter/tests/test_smelter.py`, `smelter/index` and `smelter/pdf`.*
- **A skipped resource has no points.** Points made from bytes it had before
  are taken out.
  *Held by `apps/smelter/tests/test_smelter.py`, `smelter/index` and `smelter/pdf`.*
- **Every skip is logged as a warning, with the resource, the reason, the
  media type and the checksum.** A resource is never left out of the index
  without a line that says so.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/index`.*
- **Bytes it could not read are not a decision.** Nothing is signalled, the
  index is not changed, and the failure is logged. Whoever waits is left to
  the end of its own wait.
  *Held by `apps/smelter/tests/test_smelter.py`, `apps/smelter/tests/test_properties.py` and `smelter/index`.*
- **A signal that cannot be sent does not undo what was indexed.**
  *Held by `apps/smelter/tests/test_smelter.py`.*

## A PDF's text

A PDF's text is derived, and comes with where each run of it is on a page.
[`extraction-cases.json`](../../specs/src/smelter/extraction-cases.json)
states what each kind of document becomes.

- **A document with a text layer of its own is read from that layer,** run by
  run, each with its place on its page.
  *Held by `apps/smelter/tests/test_extraction_cases.py` and `smelter/pdf`.*
- **A scanned document is read from its pixels:** each page's images are
  taken out and read by OCR, and each word is placed on the page by the place
  of the image it was read from. No fixture of the table has a word in its
  pixels, so the table holds only that a scan in which nothing can be read is
  declined; the tests named here play the OCR engine.
  *Held by `apps/smelter/tests/test_extraction.py` and `apps/smelter/tests/test_ocr_text.py`, which play the engine, and by `apps/smelter/tests/test_extraction_cases.py`, which reads a scan that has words in its pixels with the real engine.*
- **A document with pages of each kind is read both ways,** and names the
  pages that could not be read.
  *Held by `apps/smelter/tests/test_extraction_cases.py` and `apps/smelter/tests/test_extraction.py`.*
- **A page that is a grid of cells is written as rows,** each row's cells on
  one line, in their order.
  *Held by `apps/smelter/tests/test_extraction_cases.py` and `apps/smelter/tests/test_tables.py`.*
- **A filled form's values are part of its text.**
  *Held by `apps/smelter/tests/test_extraction_cases.py`.*
- **A document that cannot be parsed, or that is larger than 200 MB, is
  declined, by name,** and one too large is declined before anything parses
  it. A scanned document in which nothing can be read is declined as having
  no text layer.
  *Held by `apps/smelter/tests/test_extraction_cases.py` and `smelter/pdf`.*
- **An encrypted document is declined, by name.** No fixture the table names is encrypted.
  *Held by `apps/smelter/tests/test_extraction_cases.py`, on a document that is encrypted.*
- **The outcome says how the text was got** (its `method`), and text read by
  OCR is marked on every point made from it.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*

### The anchored-text store

- **The Smelter is the store's only writer.** The Archivist reads it, and
  answers a resource's anchored text from it
  ([ARCHIVIST.md](./ARCHIVIST.md#the-http-surface)). *Held by `smelter/pdf`.*
- **What deriving a PDF's text came to is stored under the checksum of the
  bytes, a decline as well as a text,** as an
  [`AnchoredTextEntry`](../../specs/src/components/schemas/AnchoredTextEntry.json).
  *Held by `apps/smelter/tests/test_anchored_text_store.py`, `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*
- **The entry is stored before the decision is signalled,** so whoever hears
  that content was settled finds its entry.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*
- **Text that has no places on a page has no entry.**
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*
- **Bytes whose outcome is stored are not derived again:** the stored outcome
  is what is indexed.
  *Held by `apps/smelter/tests/test_smelter.py`.*
- **An entry that cannot be written does not stop the resource being
  indexed.** The entry is found missing when the Smelter next starts
  ([Reconcile](#reconcile)).
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*
- **The writer states its stamp:** the store's directory holds a file,
  `STAMP`, with the stamp its entries carry, and a reader takes no entry
  under another, nor one of another version of the entry's form. An entry
  made by a Smelter that derives text another way is then a miss, and is
  derived again.
  *Held by `apps/smelter/tests/test_anchored_text_store.py` and `smelter/pdf`.*

## The index

- **The index is two collections of points,** one of resources' chunks and one
  of annotations, searched by cosine similarity.
  [`payload-cases.json`](../../specs/src/vectors/payload-cases.json) states
  what a point of each holds, and what is indexed for a filter.
  *Held by `packages/vectors-python/tests/test_payload_cases.py`, and for the collections a Qdrant then has by `packages/vectors-python/tests/qdrant_live.py`.*
- **A collection is as wide as the embedding model's vectors,** which the
  Smelter learns by asking the provider to embed once, when it first makes
  the collection.
  *Held by `packages/vectors-python/tests/qdrant_live.py`, against a Qdrant.*
- **What a search of the index answers is what
  [`store-cases.json`](../../specs/src/vectors/store-cases.json) states.**
  *Held by `packages/vectors-python/tests/store_contract.py`, for the in-memory store and for a Qdrant.*

## The embedding provider

A Smelter asks one provider for its vectors: an Ollama
(`POST <address>/api/embed`, with the model and a list of texts), or Voyage
(`POST https://api.voyageai.com/v1/embeddings`, with a bearer key).

- **A batch of texts is cut into slices of 128, each one request, made in
  the order of the texts,** and the vectors are given back in that order.
  *Held by `packages/vectors-python/tests/test_slices.py` and `smelter/provider`.*
- **Each request has 15 seconds of its own,** counted from when it is sent
  and not from when its batch began.
  *Held by `packages/vectors-python/tests/test_slices.py`.*
- **One request at a time is made of an Ollama, and four of Voyage,** however
  many resources are being indexed.
  *Held by `packages/vectors-python/tests/test_slices.py` and `smelter/provider`.*
- **A request that fails fails its whole batch, and says which provider,
  which model, what status and which slice.** The resource it was for gets no
  points from that attempt.
  *Held by `packages/vectors-python/tests/test_slices.py` and `smelter/provider`.*
- **A provider that answers 404 when the Smelter starts is taken to be still
  fetching the model, and one that cannot be reached to be still starting:
  either is asked again,** up to twelve times, within the time the Smelter
  has to start ([Boot](#boot)). An answer of any other failing status is not
  asked again.
  *Held by `smelter/boot` for a 404, and by `packages/vectors-python/tests/test_dimensions.py` for both.*

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
  *Held by `apps/smelter/tests/test_smelter.py`.*

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
  *Held by `apps/smelter/tests/test_smelter.py`.*
- **A resource of the catalog whose media type has text, and which has no
  points, is indexed.**
  *Held by `apps/smelter/tests/test_reconcile_cases.py` and `smelter/reconcile`.*
- **One whose points carry another checksum than the catalog states is
  indexed again.**
  *Held by `apps/smelter/tests/test_reconcile_cases.py` and `smelter/reconcile`.*
- **One whose points carry the catalog's checksum and other entity types has
  its entity types rewritten, and nothing is embedded.**
  *Held by `apps/smelter/tests/test_reconcile_cases.py` and `smelter/reconcile`.*
- **One whose points carry the catalog's checksum, whose text has places on a
  page, and whose bytes the anchored-text store has no entry for, has its
  anchored text derived again,** from the bytes as they now are, and filed
  under their checksum. Nothing is embedded, the index is not touched, and
  nothing is signalled.
  *Held by `apps/smelter/tests/test_reconcile_cases.py` and `smelter/reconcile`.*
- **Points of a resource that is none of the catalog's resources with text
  are taken out:** one that is archived, one that is gone, one whose media
  type has no text.
  *Held by `apps/smelter/tests/test_reconcile_cases.py` and `smelter/reconcile`.*
- **An annotation that quotes text, on any resource of the catalog, and has
  no point is indexed; a point whose annotation is not among them is taken
  out.**
  *Held by `apps/smelter/tests/test_reconcile_cases.py` and `smelter/reconcile`.*
- **Where it plans to index a resource and an annotation on it, the resource
  comes first,** since an annotation's point takes its mark of text read from
  pixels from the resource's points as they then are. The rest of the work is
  in no stated order.
  *Held by `apps/smelter/tests/test_reconcile_cases.py` and `smelter/reconcile`.*
- **The work is done at most eight items at a time,** each in its turn among
  its resource's events ([Order](#order)). *Held by `apps/smelter/tests/test_smelter.py`.*
- **An index that was cleared is filled again whole** by this pass, when the
  Smelter next starts. So is an anchored-text store that was cleared.
  *Held by `apps/smelter/tests/test_smelter.py`, `apps/smelter/tests/test_properties.py` and `smelter/reconcile`.*
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
  *Held by `apps/smelter/tests/test_smelter.py`, `apps/smelter/tests/test_reconcile_cases.py`, `smelter/boot` and `smelter/reconcile`.*

## Rebuild

- **`smelt:rebuild-anchors` naming a resource derives that resource's
  anchored text where the store has no entry for its bytes; naming none, that
  of every resource of the catalog whose text has places on a page.** A
  document that is declined is done, and its decline is what is stored. A
  resource named that has no such text is done, with nothing derived.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*
- **Nothing is deleted first, and an entry that is there is kept.** So a
  rebuild that fails part way has lost nothing. *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*
- **Nothing is embedded, and the index is not touched.**
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*
- **Rebuilds are done one at a time, and never while the work of reconcile
  is being done:** of a rebuild and a reconcile, the one whose work is ready
  first is done first, and the other waits. *Held by no case.*
- **It answers `smelt:rebuild-anchors-ok` when every resource was done, and
  `smelt:rebuild-anchors-failed`, saying how many of how many were not,
  otherwise.** The ones that could be done are done.
  *Held by `apps/smelter/tests/test_smelter.py` and `smelter/pdf`.*

## Health

- **`GET /health`, on the port its document states, answers `200` with a JSON
  object:** `status`;
  `eventsProcessed`, the number of events it has applied since it started;
  and `reconcile`, a `phase` (`pending`, `running`, `done` or `failed`) with
  the pass's `summary` when it is done, or its `error` when it failed.
  *Held by `smelter/boot`.*
- **The work of reconcile and of a rebuild is not counted among the events
  processed.**
  *Held by `apps/smelter/tests/test_smelter.py`, `smelter/boot` and `smelter/reconcile`.*
- **`status` is `ok` whenever the Smelter answers.** It says nothing of
  whether the Smelter can reach the gateway, its provider or its index.
  *Held by no case.*

## Stopping

- **On SIGTERM a Smelter stops applying, closes what it holds open, and exits
  with status 0.** *Held by `smelter/boot`.*

## Telemetry

- **A Smelter started with `OTEL_EXPORTER_OTLP_ENDPOINT` exports, as
  `semiont-smelter`, exactly what
  [`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json)
  lists for the smelter, and the rows of
  [`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json)
  the first names for it under `sdk`.** Those are what every service says of
  its own process (when it started, how late its loop runs, its memory), a
  span for each frame it sends and each it receives on the bus, and a count
  of the frames it sent. Every span and metric it exports is one of those
  rows, of the row's kind, carrying only the row's attributes; and every one
  of those rows that its work can make arrives, with every attribute the row
  does not mark as conditional. *Held by `smelter/telemetry`.*
- **An event it logs while a span is current carries that span's trace and
  its own id** (`trace_id` and `span_id`), in either form of its log. One
  logged in no span carries neither.
  *Held by `packages/service-python/tests/test_log.py`.*

## Environment

A Smelter's own code reads these from its environment, beside its document,
and no others:

| Variable | What it is |
|---|---|
| `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` | Its service account at the knowledge base's issuer. Required |
| the variable its document names | Its embedding provider's key, for a provider that takes one, and required then. An Ollama takes none |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The OTLP/HTTP collector its spans and metrics are exported to ([Telemetry](#telemetry)). Without it, and without the console exporter, it exports nothing and writes no span or metric anywhere |
| `OTEL_SERVICE_NAME` | The `service.name` its spans and metrics carry; `semiont-smelter` when unset or empty |
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
line to the service's output for each frame it sends and receives. It runs
the `tesseract` program, which finds its own language data.

What each telemetry variable does is what the Worker service's does
([WORKER-SERVICE.md](./WORKER-SERVICE.md#environment)): the Smelter's code for
it is the Worker's, held to it by `apps/smelter/tests/test_census.py`.

*Held by `smelter/boot`, `smelter/telemetry` and `apps/smelter/tests/test_census.py`.*

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
- **Telemetry of its own work.** No span or metric says what a Smelter
  indexed, skipped or failed on, nor how many points its index holds: its log
  and its health say the first, and nothing says the second.
