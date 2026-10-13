# Librarian

What the Librarian does: the process a librarian image runs. It answers the
questions that need the graph, the vector index or a model: what a reference
could refer to, which resources a text finds, what surrounds an annotation or
a resource, and what refers to a resource. It reads the views the Archivist
writes, the graph the Weaver writes and the index the Smelter writes, and it
records nothing. The client's side of what it answers is
[flows/MATCH.md](./flows/MATCH.md) and [flows/GATHER.md](./flows/GATHER.md);
what the record is, and what the Archivist answers, is
[ARCHIVIST.md](./ARCHIVIST.md); what the bus carries is
[EVENT-BUS.md](./EVENT-BUS.md).

A Librarian written in another language does what is written here. If the code
deviates from it, the code is wrong, or this document is wrong and is
corrected deliberately. There is no third option.

**How this document is held.** Each rule ends with *Held by* and what fails
when a Librarian breaks it. `librarian/<case>` is the file `<case>.test.ts` of
the librarian conformance suite
([`tests/conformance/librarian`](../../tests/conformance/librarian/README.md)),
which starts a Librarian as a process behind a real gateway and a real
Archivist, beside a Weaver and a Smelter that write the graph and the index it
reads, and plays its models and its embedding provider: the same cases judge
every implementation. A path names a test. Eight are runners of a case table,
which every implementation runs through its own code:
[`score-cases.json`](../../specs/src/librarian/score-cases.json), what a
reference search answers;
[`search-cases.json`](../../specs/src/librarian/search-cases.json), what a
search by text answers;
[`knowledge-graph-cases.json`](../../specs/src/librarian/knowledge-graph-cases.json),
the graph built around a resource;
[`derive-views-cases.json`](../../specs/src/librarian/derive-views-cases.json),
the lists read off that graph;
[`window-cases.json`](../../specs/src/librarian/window-cases.json), the text
cut around a selection;
[`prompt-cases.json`](../../specs/src/librarian/prompt-cases.json), the five
prompts;
[`reply-cases.json`](../../specs/src/librarian/reply-cases.json), what is read
from a model's reply; and
[`naming-cases.json`](../../specs/src/librarian/naming-cases.json), how people
are named. The runner of each is the file named for it in
`apps/librarian/tests`, such as `test_score_cases.py`. The others are tests of
Semiont's own Librarian and of the packages it is built on. A rule marked
"Held by no case" is one nothing checks.
`npm run lint:transport-contract` fails when a case or a test named here does
not exist, and when a case of the suite is named by no rule.

**It owns no store, and it reads only.** Everything a Librarian answers is
read from a store another service writes, or made by a model from what was
read. A Librarian that is stopped and started again has lost nothing. It
writes nothing anywhere: no file, no node and no edge of the graph, and in
the vector index no collection, no payload index and no point.
*Held by `apps/librarian/tests/test_census.py`, for code that names nothing that writes, and by `librarian/barriers`, for a Librarian that answers a gather and a text search as it did before it was stopped.*

## Settings

A Librarian reads its settings from a configuration document, the protocol's
[`LibrarianConfig`](../../specs/src/components/schemas/LibrarianConfig.json),
at the path its `--config` flag names. The document is resolved: no `${VAR}`
is left in it, and the Librarian defaults nothing it leaves out. It states
the gateway's URL; the issuer the Librarian's service account signs in at;
the Archivist's host and port, for a resource's bytes; the state volume and
the knowledge base's name, by which the views the Archivist writes are found;
the graph database
([`GraphConfig`](../../specs/src/components/schemas/GraphConfig.json): its
kind, and what that kind needs to be reached, with the name of the
environment variable that holds its password); the vector index
([`VectorsConfig`](../../specs/src/components/schemas/VectorsConfig.json));
the embedding provider
([`EmbeddingConfig`](../../specs/src/components/schemas/EmbeddingConfig.json):
its kind, its model and where it is reached, with the name of the variable
that holds its key, for a provider that takes one); a model for each of its
two actors, the Matcher and the Gatherer
([`LibrarianModelConfig`](../../specs/src/components/schemas/LibrarianModelConfig.json):
a provider and a model, the address the provider is reached at, and the name
of the variable that holds its key, for a provider that takes one); the
settle bound, which is how long a gather of a resource waits for the Smelter,
in milliseconds; the semantic floor, a number from 0 to 1, which is the least
score a resource needs to be found by meaning; the port its health answers
on; and how it logs.

Whoever starts a Librarian writes the document: the launcher for the
Librarian it starts, and anyone else to the same schema. The launcher writes
a settle bound of 15,000 milliseconds and a semantic floor of 0.6 where the
knowledge base's config states neither. The Librarian supplies no value.

- **Started with no `--config`, with a path it cannot read, or with a document
  that is not the schema's, it refuses to start,** and says which. A refusal
  names a member of the document and what was expected of it, and never a
  value found there. *Held by `apps/librarian/tests/test_service.py`.*
- **Without any one member of the document it refuses to start, and names the
  member that is missing:** the gateway's URL, the issuer, the Archivist's
  address, the state volume, the knowledge base's name, a graph database, a
  vector index, an embedding provider, a model for either actor, the settle
  bound, the semantic floor, its port, or how it logs.
  *Held by `apps/librarian/tests/test_service.py` and `librarian/boot`.*
- **A graph that lives in one process's memory is refused, and so is a vector
  index that does.** Neither is the store another service writes.
  *Held by `apps/librarian/tests/test_config.py` and `librarian/boot`.*
- **A settle bound that is not a whole number above 0 is refused, and so is
  one that, with the 875 milliseconds a gather can wait for the graph
  ([The knowledge graph](#the-knowledge-graph)), is not less than the time
  after which a held job is called stalled**
  ([`heldJobStallMs`](../../specs/src/client/timing.json)). The refusal names
  `gather.settleTimeoutMs`. *Held by `apps/librarian/tests/test_config.py` and `librarian/boot`.*
- **Its service account is `SEMIONT_OIDC_CLIENT_ID` and
  `SEMIONT_OIDC_CLIENT_SECRET` in its environment** ([Environment](#environment)).
  With either missing or empty it refuses to start, and names the one that is
  missing. *Held by `apps/librarian/tests/test_service.py` and `librarian/boot`.*
- **A secret is read from the variable the document names for it:** the graph
  database's password, the embedding provider's key, and the key of each
  actor's model. With that variable unset or empty it refuses to start, and
  names the member of the document and the variable. A provider that takes
  no key names no variable. A provider that takes one, in a document that
  names no variable for it, is refused by the member: `matcher.apiKeyEnv` or
  `gatherer.apiKeyEnv`.
  *Held by `apps/librarian/tests/test_config.py` and `apps/librarian/tests/test_service.py`, and by `librarian/boot`, for the graph database's password.*

## What it answers

A Librarian signs in as its service account and works as the agent `(semiont,
librarian)`: one agent, whatever models its two actors use. It reaches the bus
through the gateway. It reads the graph database and the vector index
directly, each through a reader that can write nothing; the views and the
people projection from the state volume, under `semiont/<the knowledge base's
name>` in it; a resource's bytes from the Archivist's own
`GET /resources/{id}/content`, as its service account; and a resource's
anchored text from the gateway's `GET /resources/{id}/anchored-text`.

- **It answers eight operations,** each on its result channel, or on its
  failure channel with a message, under the correlation id of the request:

  | Request | Result | Failure | What it is |
  |---|---|---|---|
  | `match:search-requested` | `match:search-results` | `match:search-failed` | [Reference search](#reference-search) |
  | `match:resources-requested` | `match:resources-result` | `match:resources-failed` | [Text search](#text-search) |
  | `match:limits-requested` | `match:limits-result` | `match:limits-failed` | [Limits](#limits) of the Matcher's model |
  | `gather:requested` | `gather:complete` | `gather:failed` | [Gathering around an annotation](#gathering-around-an-annotation) |
  | `gather:resource-requested` | `gather:resource-complete` | `gather:resource-failed` | [Gathering around a resource](#gathering-around-a-resource) |
  | `gather:summary-requested` | `gather:summary-result` | `gather:summary-failed` | [An annotation's summary](#an-annotations-summary) |
  | `gather:referenced-by-requested` | `gather:referenced-by-result` | `gather:referenced-by-failed` | [What refers to a resource](#what-refers-to-a-resource) |
  | `gather:limits-requested` | `gather:limits-result` | `gather:limits-failed` | [Limits](#limits) of the Gatherer's model |

  *Held by `apps/librarian/tests/test_librarian.py`, and by `librarian/search` and `librarian/gather`, for a result of each of the eight.*
- **A failure of `match:search-requested` carries the request's
  `referenceId`, one of `gather:requested` its `annotationId`, and one of
  `gather:resource-requested` its `resourceId`.**
  *Held by `apps/librarian/tests/test_librarian.py`, `librarian/search` and `librarian/gather`.*
- **A request whose payload is not what its channel carries is logged, and is
  answered on its failure channel where it has a correlation id and states
  what that failure names.** The failure says which members were refused,
  and nothing of what they held.
  *Held by `apps/librarian/tests/test_librarian.py`.*
- **It follows two signals:** `weave:applied`, by which it knows how far the
  Weaver has applied a resource's events, and `smelt:settled`, by which it
  knows what the Smelter decided of a resource's bytes
  ([The two waits](#the-two-waits)). It follows no recorded event. A signal
  whose payload is not its channel's is logged and passed by.
  *Held by `apps/librarian/tests/test_service.py` and `apps/librarian/tests/test_librarian.py`.*
- **Its stream names those ten channels and no other, and it awaits nothing
  on the bus.** It asks no service a question over the bus: what it needs of
  another service it reads over HTTP, or from a store.
  *Held by `apps/librarian/tests/test_service.py` and `apps/librarian/tests/test_census.py`.*
- **It records nothing, and puts no node and no edge in the graph, no point
  in the index and nothing in a view.** Connecting to the graph database
  makes no constraint and no index there, and connecting to the vector index
  makes no collection and no payload index.
  *Held by `apps/librarian/tests/test_census.py`, and by `packages/graph-python/tests/neo4j_live.py` and `packages/vectors-python/tests/qdrant_live.py`, for the two readers against a database.*
- **A search of a collection the Smelter has not made yet fails,** and makes
  none. An index nobody has started is no index that found nothing: a
  reference search, a text search and both gathers each answer on their
  failure channel, saying the index has no such collection. Every other
  failure of the index is as each operation's own rules say.
  *Held by `packages/vectors-python/tests/qdrant_live.py`, and by `apps/librarian/tests/test_reference_search.py`, `apps/librarian/tests/test_search_cases.py` and `apps/librarian/tests/test_annotation_gather.py`.*
- **A resource with no view file has no view. A file that is there and is not
  a view, or cannot be opened, is a failure that names the file,** and is
  never taken for a resource with no view. The people projection is read the
  same way ([Names](#names)).
  *Held by `apps/librarian/tests/test_record.py`.*

## Reference search

`match:search-requested` asks what a reference could refer to. The request
carries the reference's resource, the reference, and the gathered context
around it ([Gathering around an annotation](#gathering-around-an-annotation)).
[`score-cases.json`](../../specs/src/librarian/score-cases.json) states each
search as what every source answers and the candidates that follow, and is the
rule; this section says it in prose.

- **The search term is the focus's selected text and its hint, each left out
  when it is absent or empty, joined by one space.**
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for a reference with no hint.*
- **A context whose focus is not an annotation is answered on the failure
  channel, and no source is asked.**
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for the failure and for no embedding and no model being asked.*
- **Four sources are read.** The graph's listing by name, for at most 20
  resources by the term. The graph's listing by entity type, for at most 50
  resources of the context's entity types, and only when the context has any.
  The neighbours: the resources the context's graph connects the request's
  resource to ([The lists read off a graph](#the-lists-read-off-a-graph)).
  The vector index, for at most 40 chunks that score 0.4 or more against
  the embedding of the term, of any resource but the request's own, and
  only when the term is not blank: nothing, or nothing but what Unicode
  gives the White_Space property. The two listings and the index are asked
  together.
  *Held by `apps/librarian/tests/test_reference_search.py`, for what a blank term is, by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for a candidate from each of the four and one embedding of the term.*
- **A neighbour and a vector hit are each read back as a resource from the
  graph, and from the views when the graph has none or its read fails.** One
  neither holds is no candidate, and neither is one whose view cannot be
  read: the search is answered with the others.
  *Held by `apps/librarian/tests/test_score_cases.py`, `apps/librarian/tests/test_grace.py` and `apps/librarian/tests/test_reference_search.py`, and by `librarian/barriers`, for a vector hit the graph does not hold yet.*
- **A listing by name that fails fails the search,** with the failure's
  message. *Held by `apps/librarian/tests/test_score_cases.py`.*
- **A listing by entity type that fails fails the search too.**
  *Held by `apps/librarian/tests/test_reference_search.py`.*
- **An embedding or an index that fails has answered no hits,** and the
  search goes on with the other sources.
  *Held by `apps/librarian/tests/test_score_cases.py` and `apps/librarian/tests/test_reference_search.py`, and by `librarian/search`, for an embedding that fails.*
- **A resource is one candidate however many sources found it,** and is
  counted as found by each source that answered it.
  *Held by `apps/librarian/tests/test_score_cases.py`.*
- **The request's own resource is no candidate,** whichever source answers
  it. A reference does not refer to the resource it is on.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for a resource that holds the quoted text.*
- **The answer is the candidates ordered by score, the highest first.**
  Candidates of one score stay in the order they were found: the listing by
  name, the listing by entity type, the neighbours in the order of the
  graph's edges, the vector index's hits. Each candidate is its resource's
  description with `score` and `matchReason` added.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for the highest score first and what each candidate carries.*
- **When the request states a `limit`, the answer is at most that many of
  the first candidates.**
  *Held by `apps/librarian/tests/test_score_cases.py` and `librarian/search`.*
- **A `limit` is 1 to 200.** The schema of the request states the bounds, so
  a gateway refuses a request outside them before a Librarian is asked. A
  Librarian asked by another way fails a `limit` less than 1, in the words
  `limit must be at least 1`, and asks no source.
  *Held by `apps/librarian/tests/test_reference_search.py`, and by `gateway/emit.test.ts`, for the bounds of a text search's.*

### The score

A candidate's score is the sum of these terms, added in this order.

- **The sum is rounded to two decimals, a half going up.**
  *Held by `apps/librarian/tests/test_reference_search.py`.*
- **Entity types,** only when the context and the candidate each have any:
  30 times the types they share divided by the distinct types of both
  together; and, for each shared type, 5 divided by the base-2 logarithm of
  one more than the type's frequency in the context's
  `metadata.entityTypeFrequencies`. A type with no stated frequency, or with
  one below 1, counts as seen once.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `apps/librarian/tests/test_reference_search.py`, for a frequency below 0.*
- **Connection:** 20 when the context's graph connects the request's
  resource to the candidate both ways, 10 when it connects it one way.
  *Held by `apps/librarian/tests/test_score_cases.py`.*
- **What cites the request's resource adds nothing to any candidate.** It
  says nothing of the candidate.
  *Held by `apps/librarian/tests/test_score_cases.py`.*
- **Name,** the candidate's name and the term compared without regard to the
  case of letters: 25 when they are equal, else 15 when the name begins with
  the term, else 10 when the name has the term in it. A blank term matches
  no name. *Held by `apps/librarian/tests/test_score_cases.py`.*
- **Recency,** for a candidate that states `dateCreated`: 5 times one less
  the candidate's age in days divided by 30, and nothing from thirty days
  on. Nothing for a date after the moment of the search, and nothing for a
  `dateCreated` that cannot be read as a date.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `apps/librarian/tests/test_reference_search.py`, for what is no date.*
- **Vector index:** 25 times the hit's score, and of several hits of one
  resource the highest of their scores. Such a resource is read back once.
  *Held by `apps/librarian/tests/test_score_cases.py`.*
- **Several sources:** 3 for each source that found the candidate, when more
  than one did. *Held by `apps/librarian/tests/test_score_cases.py`.*
- **The reason is what the score was made of, in this order, joined by `; `:**
  `entity types: ` and the shared types, joined by `, `; `bidirectional
  connection` or `connected`; `exact name match`, `prefix name match` or
  `contains name match`; `semantic similarity` for a vector hit; and the
  count of sources followed by ` retrieval sources`, when more than one found
  it. A candidate with none of these has the reason `candidate`.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for the entity types, a connection, a name match and a vector hit.*

### The model's score

- **The Matcher's model is asked once, with the score prompt
  ([The prompts](#the-prompts)), for at most twenty candidates,** unless the
  request states `useSemanticScoring` as false or there is no candidate.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for the one prompt and for none where the request asks for no scoring by a model.*
- **It is shown the twenty candidates of the highest scores,** numbered from
  1 with the highest first, and those of one score in the order they were
  found. *Held by `apps/librarian/tests/test_score_cases.py`.*
- **What a comment or an assessment says is a line of the prompt:** the text
  of the first item of the annotation's body whose purpose is `commenting`
  or `assessing`. An item that is there for another purpose, or states none,
  is not shown. *Held by `apps/librarian/tests/test_reference_search.py`.*
- **Each score it gives a candidate it was shown adds 25 times that score,**
  and the sum is rounded to two decimals again. A score above 0.5 adds
  `semantic match` to the reason, and is the whole reason of a candidate
  whose reason was `candidate`.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for a higher score and the reason.*
- **A reply is read a line at a time, as
  [`reply-cases.json`](../../specs/src/librarian/reply-cases.json) states:**
  a line gives a score when it starts with a candidate's number, a full stop
  and a score from 0 to 1. Every other line gives nothing, and is no error:
  a score that is no number, such as `0.8.5` or `0.8.`, among them. Where two
  lines score one candidate, the later is read.
  *Held by `apps/librarian/tests/test_reply_cases.py`.*
- **A model that fails, or whose reply states no score, leaves the scores as
  they were,** and the search is answered.
  *Held by `apps/librarian/tests/test_score_cases.py`, and by `librarian/search`, for a model that fails.*

## Text search

`match:resources-requested` asks which resources a text finds. The request
carries the text, and may carry `archived`, one `entityType`, an `offset` and
a `limit`.
[`search-cases.json`](../../specs/src/librarian/search-cases.json) states each
search as what each store answers and the page that follows, and is the rule.

- **The text is searched without the white space before and after it, which
  is what Unicode gives the White_Space property. A text that is then empty
  finds nothing, and no store is asked:** the page has no resources, a total
  of 0, and is `lexical`.
  *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`.*
- **A `limit` is 1 to 200, and an `offset` is 0 or more.** The schema of the
  request states the bounds, so a gateway refuses a request outside them
  before a Librarian is asked. A Librarian asked by another way fails a
  `limit` less than 1, in the words `limit must be at least 1`, and asks no
  store. *Held by `apps/librarian/tests/test_search_cases.py` and `gateway/emit.test.ts`.*
- **Otherwise the graph's listing is asked,** with the text, with `archived`
  and the entity type where they are given, with the offset, which is 0 where
  none is given, and with the limit, which is 50 where none is given. The
  graph applies every filter before it cuts the page, and answers the page
  and the total of all that match. A resource matches when every word of the
  text is in its name, in where its bytes are stored or in one of its entity
  types, whatever the case of letters. The matches are ordered by how the
  name answers the text: a name that is the text, then one that begins with
  it, then one that has every word of it, then the rest; within each, the
  newest first, and by id where two were made at one moment.
  *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`, and by `packages/graph-python/tests/contract.py`, for what matches and the order.*
- **A graph that fails fails the search,** on the failure channel.
  *Held by `apps/librarian/tests/test_search_cases.py`.*
- **Where the graph's total is more than 0, or the offset is more than 0,
  the page is the graph's and is `lexical`,** and nothing else is asked. Only
  a first page that found nothing is answered by meaning.
  *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`.*
- **A search for archived resources is answered by the graph alone:** where
  `archived` is true and nothing matched, the page is the graph's, empty and
  `lexical`, and nothing is embedded. The index holds no chunk of an archived
  resource ([SMELTER.md](./SMELTER.md#what-each-event-does)).
  *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`.*
- **Otherwise the text is embedded once, and the vector index is asked for
  four times the page's limit of chunks.** Its hits are folded to one for
  each resource: the hit with the highest score, with that chunk's text.
  *Held by `apps/librarian/tests/test_search_cases.py`, and by `librarian/search`, for the one embedding and one hit for each resource.*
- **A search kept to an entity type asks the index for chunks of resources
  of that type alone.** A search that states `archived` as false is asked of
  it as one that states no `archived` is.
  *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`.*
- **A resource is kept when its score is the semantic floor or more.** The
  kept are ordered by score, the highest first, and by nothing else. `total`
  is how many are kept. *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`.*
- **The first `limit` of the kept are read back, each in turn, from the
  graph, and from the views where the graph has no such resource or fails.**
  One neither has, and one whose view cannot be read, is left out of the
  page, and the others are read. A resource read from its view is counted in
  a line of the log. Each resource of the page carries
  its chunk's text as `content`, and the page is `semantic`, also where
  nothing is kept. *Held by `apps/librarian/tests/test_search_cases.py`, and by `librarian/search`, for the page and each chunk's text, and `librarian/barriers`, for a resource read from its view.*
- **Where the embedding or the index fails, the answer is the page with no
  resources, a total of 0, and `lexical`.** A search that found nothing does
  not become a failure. An index with no such collection fails the search.
  *Held by `apps/librarian/tests/test_search_cases.py`, and by `librarian/search`, for an embedding that fails.*
- **Each resource of a lexical page is given a preview as `content`; a
  semantic page's `content` is left as it is.**
  *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`.*
- **A preview is the first 200 code points of the resource's text, for a
  resource whose bytes are its text;** the bytes are read once, by the
  resource's id. A resource with no stored bytes, one whose text is derived,
  and one that has no text preview as the empty string, and no bytes are
  read. A read that fails previews as the empty string, and the other
  resources keep theirs.
  *Held by `apps/librarian/tests/test_search_cases.py` and `apps/librarian/tests/test_resource_text.py`, and by `librarian/search`, for a text shorter than 200 code points and for a PDF.*
- **The reply carries the page's resources, `total`, the `offset` and the
  `limit` the search was made with, and `matchKind`,** and its people are
  named ([Names](#names)).
  *Held by `apps/librarian/tests/test_search_cases.py` and `librarian/search`.*

## The knowledge graph

Both gathers build the graph around one resource, from the graph database and
the views, to a depth.
[`knowledge-graph-cases.json`](../../specs/src/librarian/knowledge-graph-cases.json)
states each build as what the stores answer and the graph that follows, or the
failure, and is the rule.

- **The first node is the resource. Then each of its connections is a node
  and an edge from the resource to it,** the edge's `type` `link`, with the
  connection's `bidirectional` flag.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`, and by `librarian/gather`, for the resource first and a resource a reference links to.*
- **Then each annotation elsewhere that refers to the resource:** its citing
  resource is a node, named and typed by its view, or named by its id and
  with no entity types where it has no view that can be read; the annotation
  is a node; an
  `annotation-of` edge runs from the annotation to its citing resource, and a
  `cites` edge from the annotation to the resource. An annotation that is on
  the resource itself is not a citation. A citing resource that is a node
  already, as one the resource links to is, keeps the name it has, and its
  view is not read for it.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`, and by `apps/librarian/tests/test_resource_gather.py`, for which views are read and for one that cannot be.*
- **Then each annotation on the resource is a node, with an `annotation-of`
  edge to the resource.**
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py` and `librarian/gather`.*
- **An annotation's node carries the whole annotation,** with its motivation
  as its label and the entity types its tagging bodies state.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`.*
- **A thing is a node once,** and keeps the name it was first given. Each
  connection has its edge all the same.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`.*
- **A graph is built to a depth, 1 to 3: how many links out from the
  resource it reaches.** The rules above are the graph one link out, a depth
  of 1, and it comes first in the graph whatever the depth. A gather around
  an annotation builds to 1, and a gather around a resource to the `depth`
  it states.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`, `apps/librarian/tests/test_annotation_gather.py` and `apps/librarian/tests/test_resource_gather.py`, and by `librarian/gather`, for a chain of three resources at a depth of 1 and of 2.*
- **Each further link out starts from the resources the step before added,
  in the order they were added.** Each is asked for what it links to, and
  then for what cites it. What it links to is a resource node, named and
  typed by the description the graph database answers with the connection,
  and a `link` edge runs to it, with the connection's `bidirectional` flag.
  What cites it is a resource node, named and typed by its view, or named by
  its id where it has no view, and a `link` edge runs from it, with no
  `bidirectional` flag. So the graph's resource nodes are nearest first.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`, and by `librarian/gather`, for the edge from the second resource of a chain to the third.*
- **Only the resource the graph is built around has annotations as nodes.**
  The annotations on a resource further out, and those that cite it, are not
  read as nodes.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`.*
- **Beyond the first link out, a link found twice is one edge, the first
  found.** Two resources that each link to the other have an edge each way,
  unless the first found says it goes both ways: that edge then stands for
  both. A link back to the resource the graph is built around adds no node
  and has its edge.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`.*
- **A resource is asked once, and the resource the graph is built around is
  not asked again.** Nothing waits for a resource further out.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`.*
- **From the second link out on, a graph that holds 200 resource nodes takes
  no more.** A resource that is not in it is not added, no edge runs to it
  or from it, and it is not asked. The graph then states `truncated` as
  true, and a graph the ceiling kept nothing out of does not state it. The
  graph one link out is not cut.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py` and `apps/librarian/tests/test_resource_gather.py`.*
- **A resource neither the graph database nor the views hold is unknown:**
  the build fails at once, and nothing waits.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`.*
- **A resource the views hold and the graph database does not is waited
  for** ([The two waits](#the-two-waits)).
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py` and `librarian/barriers`.*

### The lists read off a graph

[`derive-views-cases.json`](../../specs/src/librarian/derive-views-cases.json)
states what is read off a knowledge graph for a main resource: what it is
connected to, what cites it, and the entity types of the other annotations on
it. The reference search reads the first two from the context it is given,
and the relationship prompt is made from all three.

- **A citation is a `cites` edge to the main resource from an annotation that
  an `annotation-of` edge places on a resource.** That resource cites the
  main resource, once however many of its annotations do.
  *Held by `apps/librarian/tests/test_derive_views_cases.py` and `packages/core/src/__tests__/derive-views-cases.test.ts`.*
- **A connection is any other edge whose source is the main resource,**
  whatever its type, with the name and entity types of its target's node and
  the edge's `bidirectional` flag, which is false where the edge states none.
  *Held by `apps/librarian/tests/test_derive_views_cases.py` and `packages/core/src/__tests__/derive-views-cases.test.ts`.*
- **The sibling entity types are those of the annotation nodes on the main
  resource, but for the focal annotation,** each once.
  *Held by `apps/librarian/tests/test_derive_views_cases.py` and `packages/core/src/__tests__/derive-views-cases.test.ts`.*

## The two waits

A gather reads stores that are written after the record. It waits for each,
within a bound, and nothing else it does waits.

- **It keeps, for each resource, the highest sequence number `weave:applied`
  has signalled, and the last decision `smelt:settled` has signalled.** What
  it keeps is forgotten when it stops. An entry more than five minutes old
  may be forgotten before that, as another signal is noted, and every signal
  of a resource makes its entry new, one that states nothing new among them.
  A Librarian that hears no signal forgets nothing: it holds no more than it
  did, and what it holds still answers a wait.
  *Held by `apps/librarian/tests/test_progress.py`.*
- **The wait for the graph.** When the views hold a resource and the graph
  database does not, the build waits at most 500 milliseconds for
  `weave:applied` to reach the sequence number the resource's view states,
  and reads the graph again when it does. If the graph still does not hold
  the resource, or the signal did not come, it reads again after 25 more
  milliseconds, then after 50, 100 and 200 more, and the first read that
  holds the resource ends the wait: 875 milliseconds at most.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`, and by `librarian/barriers`, for a wait of 700 milliseconds or more that ends well inside the request's own.*
- **A graph that never comes to hold the resource fails the gather,** with a
  message that says the graph is behind the views and that the resource is
  not missing. It is logged as a warning and counted
  (`semiont.gather.degraded`, `projection` `graph`).
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`, and by `librarian/barriers`, for the failure and its message.*
- **The wait for the index, which only a gather of a resource makes, and
  only for bytes the index does not hold yet.** When the index answers no
  match for the resource, it is asked what it holds of the resource. Points
  of the bytes the resource's description states are a resource that is
  indexed and that nothing is like: nothing waits. Nothing waits either for
  a resource whose description states no checksum, or a media type that has
  no text, which the Smelter does not index. Otherwise the gather waits, for
  the settle bound at most, for `smelt:settled` to state a decision of
  exactly that checksum. A decision it already keeps ends the wait at once.
  On `indexed` it asks the index again; on `skipped` it does not.
  *Held by `apps/librarian/tests/test_resource_gather.py` and `apps/librarian/tests/test_progress.py`, and by `librarian/barriers`, for a resource the Smelter then indexes, for one it skips, and for an indexed resource and an image asked of a Librarian that has heard no decision.*
- **An index that does not settle within the bound leaves the context
  without `semanticContext`, and the gather is answered.** It is logged as a
  warning and counted (`semiont.gather.degraded`, `projection` `vectors`).
  *Held by `apps/librarian/tests/test_resource_gather.py`, and by `librarian/barriers`, for the answer, when it comes and the warning.*
- **The counter has five values of `projection`:** `graph`, a graph that
  did not come to hold the resource; `vectors`, an index that failed or did
  not settle in time; and three for what a model failed to give:
  `suggestions`, the summary and suggestions of a resource; `summary`, the
  summary of the resource an annotation links to; and `relationship`, the
  relationship sentence
  ([What a failed read does](#what-a-failed-read-does)). A gather is counted
  once for each it went without.
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py`, for a graph that stayed behind, `apps/librarian/tests/test_resource_gather.py` and `apps/librarian/tests/test_annotation_gather.py`, for the others, and by `librarian/telemetry`, for each value arriving.*
- **A wait that fails in any way but running out fails the gather.**
  *Held by `apps/librarian/tests/test_knowledge_graph_cases.py` and `apps/librarian/tests/test_resource_gather.py`.*

## Gathering around an annotation

`gather:requested` names an annotation and its resource, and may state
`includeSourceContext` and `includeTargetContext`, each true where it is not
stated, and `contextWindow`, 1,000 where it is not stated. The answer is a
`GatheredContext` whose focus is the annotation. The reads are made in the
order of the rules below.

- **A `contextWindow` less than 100 or more than 5,000 fails the gather,**
  and nothing is read. The schema of the request states the same bounds, so
  a gateway refuses such a request before a Librarian is asked.
  *Held by `apps/librarian/tests/test_window_cases.py` and `apps/librarian/tests/test_annotation_gather.py`, by `gateway/emit.test.ts`, and by `librarian/gather`, for a window of 99 and one of 5,001, and no model asked.*
- **The resource's view is read, and the annotation is found in it by its
  id.** A resource with no view, an annotation the view does not hold, and an
  annotation whose target names another resource each fail the gather.
  *Held by `apps/librarian/tests/test_annotation_gather.py`, and by `librarian/gather`, for an annotation the view does not hold and for one on another resource.*
- **Where the annotation's body links to a resource, that resource's view is
  read,** and its description is the focus's `targetResource`. A link to a
  resource with no view, or with one that cannot be read, gives none.
  *Held by `apps/librarian/tests/test_annotation_gather.py`, and by `librarian/gather`, for a link to a resource that has a view.*
- **The selected text is cut from the resource's text,** when
  `includeSourceContext` is true. A resource with no stored bytes fails the
  gather. A resource whose text is not there, a PDF the Smelter has not yet
  derived the text of or a media type with none, gives no selected text, and
  the gather goes on.
  *Held by `apps/librarian/tests/test_annotation_gather.py`, and by `librarian/gather`, for a text that is there, with and without the option.*
- **A resource's text is its bytes decoded, read from the Archivist, where
  its media type says its bytes are its text; its anchored text, read from
  the gateway, where its text is derived; and nothing where the media type
  has no text**
  ([`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json)).
  A read of bytes that fails fails the gather.
  *Held by `apps/librarian/tests/test_resource_text.py`, and by `librarian/gather`, for a text and for a PDF.*
- **The cut is the selection, and `contextWindow` of text before it and after
  it, counted in Unicode code points,** as
  [`window-cases.json`](../../specs/src/librarian/window-cases.json) states.
  A position selector selects from its `start` to its `end`; a quote
  selector selects where the text has its `exact` words. Words the text does
  not have, a target with no selector, and a selector of another kind give
  no selected text, and the gather goes on.
  *Held by `apps/librarian/tests/test_window_cases.py`, and by `librarian/gather`, for a window of 100 and for none stated.*
- **The linked resource's text is read, when `includeTargetContext` is true
  and it has stored bytes,** and the focus's `targetContext` is the start of
  that text, twice `contextWindow` code points long, with a summary of the resource from
  the Gatherer's model (the resource-summary prompt). A model that fails
  leaves `targetContext` with the text and no summary, and the gather goes
  on, counted (`projection` `summary`).
  *Held by `apps/librarian/tests/test_annotation_gather.py`, and by `librarian/gather`, for the option, a text shorter than that, a PDF's text, the summary, and a model that fails on it.*
- **The knowledge graph of the resource is built, one link out**
  ([The knowledge graph](#the-knowledge-graph)), and is the context's
  `graph`. A build that fails fails the gather.
  *Held by `apps/librarian/tests/test_annotation_gather.py`, and by `librarian/gather`, for the graph.*
- **The graph database is asked how many resources carry each entity type,**
  and the answer is `metadata.entityTypeFrequencies`. A read that fails
  fails the gather. `metadata.entityTypes` are those the annotation's tagging
  bodies state, `metadata.language` is the resource's, and
  `metadata.resourceType` is `document`.
  *Held by `apps/librarian/tests/test_annotation_gather.py`, and by `librarian/gather`, for the frequencies and the entity types.*
- **Where a selection was cut, the Gatherer's model is asked for the
  relationship sentence** (the relationship prompt), made from the passage
  and the lists read off the graph. A model that fails leaves the context
  without `inferredRelationshipSummary`, and the gather goes on, counted
  (`projection` `relationship`).
  *Held by `apps/librarian/tests/test_annotation_gather.py` and `librarian/gather`.*
- **Where the selected text is not empty, it is embedded, and the vector
  index is asked for at most 10 annotations that score 0.5 or more and are
  on another resource.** Each is named by its resource's view, and one whose
  resource has no view, a view that cannot be read, or a view that states an
  empty name, is left out. The matches are `semanticContext`, which is
  absent where there are none. An embedding or an index that fails here
  leaves the context without it, and the gather goes on, counted
  (`projection` `vectors`). An index with no such collection fails the
  gather.
  *Held by `apps/librarian/tests/test_annotation_gather.py`, and by `librarian/gather`, for the one embedding, a match on another resource with its name, and none from the annotation's own.*

## Gathering around a resource

`gather:resource-requested` names a resource and states `depth`,
`maxResources`, which is 1 to 200 by the request's schema, `includeContent`
and `includeSummary`, and may state `excludeEntityTypes`. The answer is a
`GatheredContext` whose focus is the resource. The reads are made in the
order of the rules below.

- **A `depth` less than 1 or more than 3 fails the gather,** and nothing is
  read. The schema of the request states the same bounds, so a gateway
  refuses such a request before a Librarian is asked.
  *Held by `apps/librarian/tests/test_resource_gather.py`, and by `librarian/gather`, for a depth of 4.*
- **The resource's view is read.** A resource with no view fails the gather.
  *Held by `apps/librarian/tests/test_resource_gather.py`, `librarian/gather` and `librarian/barriers`.*
- **The resource's text is read when `includeContent` or `includeSummary`
  is true.** It is the focus's `content.main` where it is not empty and
  `includeContent` is true. The focus states `content` whenever
  `includeContent` is true, and not otherwise.
  *Held by `apps/librarian/tests/test_resource_gather.py`, and by `librarian/gather`, for a text, for a PDF, and for a summary asked for without the texts.*
- **The knowledge graph of the resource is built, `depth` links out**
  ([The knowledge graph](#the-knowledge-graph)), and is the context's
  `graph`. A build that fails fails the gather.
  *Held by `apps/librarian/tests/test_resource_gather.py`, and by `librarian/gather`, for the graph at a depth of 1 and of 2, and `librarian/barriers`, for a build that fails.*
- **The related resources are the first `maxResources` less one of the
  graph's resource nodes, but for the resource itself,** which are the
  nearest to it. The view of each is
  read, and one with no view, or with one that cannot be read, is passed by.
  When `includeContent` is true the
  text of each is read, and `content.related` holds each text that is not
  empty, by resource id. A read of bytes that fails fails the gather.
  *Held by `apps/librarian/tests/test_resource_gather.py`, and by `librarian/gather`, for how many are read and what is held of each.*
- **When `includeSummary` is true and the resource's text is not empty, the
  Gatherer's model is asked:** first for a
  summary (the resource-summary prompt), then for suggestions (the
  reference-suggestions prompt, with the resource's name and its first
  entity type). They are the focus's `summary` and `suggestedReferences`.
  Where `includeSummary` is false the model is asked nothing.
  *Held by `apps/librarian/tests/test_resource_gather.py` and `librarian/gather`.*
- **A reply to the suggestions prompt is read as
  [`reply-cases.json`](../../specs/src/librarian/reply-cases.json) states:**
  the first three lines that are not empty, each without the bullet that
  starts it. An empty reply gives no suggestions.
  *Held by `apps/librarian/tests/test_reply_cases.py`, and by `librarian/gather`, for a reply of two lines with no bullet.*
- **A model that fails at either leaves the context with neither, and the
  gather is answered.** It is logged as a warning and counted
  (`semiont.gather.degraded`, `projection` `suggestions`).
  *Held by `apps/librarian/tests/test_resource_gather.py`, and by `librarian/gather`, for the answer.*
- **The vector index is asked for what is like the resource:** at most
  `maxResources` passages of other resources that score 0.5 or more against
  the resource's own stored vectors, without those of the entity types the
  request excludes. Nothing is embedded. Where the index answers no match
  and does not hold the resource's bytes yet, the gather waits for the index
  ([The two waits](#the-two-waits)).
  *Held by `apps/librarian/tests/test_resource_gather.py`, `librarian/gather` and `librarian/barriers`.*
- **Each match is named by its resource's view, and one whose resource has
  no view, a view that cannot be read, or a view that states an empty name,
  is left out.** The matches
  are `semanticContext`, with the entity types that were excluded where any
  were; it is absent where there are no matches.
  *Held by `apps/librarian/tests/test_resource_gather.py`, and by `librarian/gather`, for the names and the excluded entity types, and `librarian/barriers`, for none.*
- **An index that fails leaves the context without `semanticContext`, and
  the gather is answered.** It is logged as a warning and counted
  (`semiont.gather.degraded`, `projection` `vectors`), and nothing waits. An
  index with no such collection fails the gather.
  *Held by `apps/librarian/tests/test_resource_gather.py`.*
- **`metadata` states the resource's language and `resourceType`
  `document`,** and no entity types. The language is the one the resource's
  primary representation states, and `metadata` states none where that
  states none.
  *Held by `apps/librarian/tests/test_resource_gather.py`.*

## An annotation's summary

`gather:summary-requested` names an annotation and its resource.

- **The resource's view is read and the annotation found in it. Then the
  view of the resource the annotation's target names is read, and that
  resource's text.** A resource with no view, an annotation the view does
  not hold, a text that is not there, and a target with no position selector
  each fail the request.
  *Held by `apps/librarian/tests/test_summary.py` and `apps/librarian/tests/test_window_cases.py`, and by `librarian/gather`, for an annotation the view does not hold.*
- **The text is cut around the annotation's position, 500 code points on
  each side,** as
  [`window-cases.json`](../../specs/src/librarian/window-cases.json) states.
  *Held by `apps/librarian/tests/test_window_cases.py`.*
- **The Gatherer's model is asked for the summary** (the annotation-summary
  prompt). A model that fails fails the request.
  *Held by `apps/librarian/tests/test_summary.py`, and by `librarian/gather`, for the one prompt and the model it is sent to.*
- **The answer is the `summary`; `relevantFields`, with the resource's id,
  its name and the annotation's entity types; and `context`:** the last 200 code
  points of the text before the selection, the selection, and the first 200
  of the text after it.
  *Held by `apps/librarian/tests/test_summary.py` and `librarian/gather`.*

## What refers to a resource

`gather:referenced-by-requested` names a resource, and may name a
`motivation`, which is one an annotation can have: the schema of the request
states which those are, and a gateway refuses any other word, the empty text
among them.

- **The resource's view is read first, and a resource with no view fails
  the request.** A resource nobody made is no resource nothing refers to.
  *Held by `apps/librarian/tests/test_referenced_by.py` and `librarian/search`.*
- **The graph database is asked for the annotations that refer to the
  resource,** of that motivation where one is named, and all of them where
  none is named. A graph that fails fails the request.
  *Held by `apps/librarian/tests/test_referenced_by.py`, and by `librarian/search`, for the annotations and the motivation, and `gateway/emit.test.ts`, for a word that is no motivation.*
- **Each resource those annotations are on is read once, from the graph, and
  from the views where the graph has none or its read fails.** A resource
  whose view cannot be read is one nobody holds.
  *Held by `apps/librarian/tests/test_referenced_by.py` and `apps/librarian/tests/test_grace.py`.*
- **The answer has one entry for each annotation, in the graph's order:** its
  `id`; `resourceName`, the name of the resource it is on; and `target`, with
  that resource as `source` and, as `selector.exact`, the words its quote
  selector states, or the empty string where it has none. An entry states no
  `resourceName` where nobody holds a description of its resource, and where
  the name is empty: no name is made up for it. Its people are named
  ([Names](#names)).
  *Held by `apps/librarian/tests/test_referenced_by.py`, and by `librarian/search`, for an entry.*

## Limits

- **`match:limits-requested` is answered with the limits of the Matcher's
  model, and `gather:limits-requested` with those of the Gatherer's:** a list
  of one item, the provider, the model, and the model's `contextTokens`,
  `maxOutputTokens` and, where the provider says, `acceptsTemperature`.
  *Held by `apps/librarian/tests/test_librarian.py`, `packages/inference-python/tests/test_limits_report.py` and `librarian/search`.*
- **A provider that has not said within 1.5 seconds, or that fails, leaves
  the list empty, and the request is still answered on its result channel.**
  A later request states the limits once the provider has said them.
  *Held by `packages/inference-python/tests/test_limits_report.py`, and by `librarian/search`, for an answer within 5 seconds.*

## Names

No stored thing carries a person's name. The Archivist keeps what the
knowledge base calls each person in the people projection, on the state
volume.

- **The replies to a reference search, to a text search and to what refers
  to a resource have their people named:** every object whose `@type` is `Person`, wherever in the
  reply it is, and whose `@id` the projection holds, has its `name` set to
  the name stated there, in place of any it carried. A person whose `@id`
  the projection does not hold is left as it is, whatever text the `@id` is.
  Nothing else of the reply changes, as
  [`naming-cases.json`](../../specs/src/librarian/naming-cases.json) states.
  *Held by `apps/librarian/tests/test_naming_cases.py` and `apps/librarian/tests/test_reference_search.py`, and by `librarian/search`, for a text search's lexical page, its semantic one, and a candidate of a reference.*
- **The projection is read once for each reply.** A knowledge base with no
  projection names no one.
  *Held by `apps/librarian/tests/test_naming_cases.py` and `apps/librarian/tests/test_record.py`.*
- **A projection that cannot be read is logged as a warning, and the reply
  is sent with no one named.**
  *Held by `apps/librarian/tests/test_naming_cases.py`, `apps/librarian/tests/test_search_cases.py` and `apps/librarian/tests/test_referenced_by.py`.*
- **The replies to the two gathers, to a summary and to the two limits
  requests are not named.** *Held by no case.*

## What a failed read does

Each operation makes several reads, and each read can fail. One rule decides
what a failure does: **a read the answer cannot be made without fails the
request; a read that only adds to the answer leaves the answer without that
part, and says so.** The sections above state each case where it arises.
This one states them together.

- **A request fails, on its failure channel, with what failed, when it
  cannot read what the answer is about or is made of:** the view of the
  resource it names; the bytes of a text it was asked for; the graph, in a
  listing, in the build of a knowledge graph, in a count of entity types and
  in a list of what refers to a resource; and the model, in an annotation's
  summary, which is nothing but what the model says.
  *Held by `apps/librarian/tests/test_annotation_gather.py`, `apps/librarian/tests/test_resource_gather.py`, `apps/librarian/tests/test_summary.py`, `apps/librarian/tests/test_referenced_by.py`, `apps/librarian/tests/test_score_cases.py` and `apps/librarian/tests/test_search_cases.py`.*
- **A gather that goes without a part is answered, logged as a warning and
  counted** on `semiont.gather.degraded`, by what it went without
  ([The two waits](#the-two-waits)).
  *Held by `apps/librarian/tests/test_annotation_gather.py` and `apps/librarian/tests/test_resource_gather.py`.*
- **A search that goes without a source is answered, and logged as a
  warning.** No counter counts it ([Known defects](#known-defects)).
  *Held by `apps/librarian/tests/test_reference_search.py` and `apps/librarian/tests/test_search_cases.py`.*
- **A view that only adds to an answer, and cannot be read, is passed over
  with a warning that names its resource:** one candidate of a search, one
  hit of a page, one related resource, one similar passage, the name of a
  citing resource, the resource an annotation links to. A view that is not
  there is no failure, and nothing is logged of it.
  *Held by `apps/librarian/tests/test_grace.py`, `apps/librarian/tests/test_reference_search.py`, `apps/librarian/tests/test_annotation_gather.py`, `apps/librarian/tests/test_resource_gather.py` and `apps/librarian/tests/test_referenced_by.py`.*
- **A file that is there and is no view is never taken for a view that is
  not there.** It is a failure that names the file: of the request, for the
  view the answer is about, and a warning, for one that only adds.
  *Held by `apps/librarian/tests/test_record.py` and `apps/librarian/tests/test_grace.py`.*
- **An index with no such collection fails every request that asks it,**
  where an index that fails in any other way does not: nobody has started
  the index, and that is no empty answer.
  *Held by `apps/librarian/tests/test_reference_search.py`, `apps/librarian/tests/test_search_cases.py`, `apps/librarian/tests/test_annotation_gather.py` and `apps/librarian/tests/test_resource_gather.py`.*

| Operation | Read | When it fails |
|---|---|---|
| reference search | the listing by name, the listing by entity type | the search fails |
| | the embedding of the term, the vector index | answered from the other sources; logged |
| | a candidate's description: the graph | read from its view |
| | a candidate's description: its view | that candidate is left out; logged |
| | the model | answered with the scores as they were; logged |
| text search | the listing | the search fails |
| | the embedding, the vector index | the empty `lexical` page; logged |
| | a hit's description: the graph | read from its view |
| | a hit's description: its view | that hit is left out; logged |
| | a preview's bytes | the empty string |
| | the people projection | no one is named; logged |
| gather around an annotation | the resource's view | the gather fails |
| | the linked resource's view | no `targetResource`; logged |
| | the resource's text, the linked resource's text | the gather fails |
| | the model, for the linked resource's summary | `targetContext` without `summary`; counted `summary` |
| | the graph: the build, the counts of entity types | the gather fails; a graph behind its view is counted `graph` |
| | a citing resource's view | the node is named by its id; logged |
| | the model, for the relationship sentence | no `inferredRelationshipSummary`; counted `relationship` |
| | the embedding of the selection, the vector index | no `semanticContext`; counted `vectors` |
| | a similar annotation's view | that match is left out; logged |
| gather around a resource | the resource's view | the gather fails |
| | the resource's text, a related resource's text | the gather fails |
| | the graph | as around an annotation |
| | a related resource's view | that resource is left out; logged |
| | the model, for the summary and the suggestions | neither; counted `suggestions` |
| | the vector index, and the Smelter's decision when it does not come in time | no `semanticContext`; counted `vectors` |
| | a similar passage's view | that match is left out; logged |
| an annotation's summary | a view, the text, the model | the request fails |
| what refers to a resource | the resource's view, the graph's list | the request fails |
| | a citing resource's description: the graph | read from its view; logged |
| | a citing resource's description: its view | its entry states no name; logged |
| | the people projection | no one is named; logged |
| limits | the provider | left out of the list |

In every row, a vector index with no such collection fails the request.

## The prompts

A Librarian sends a model five prompts.
[`prompt-cases.json`](../../specs/src/librarian/prompt-cases.json) states what
each is made from and its text to the last character, and is the rule.

- **Each prompt's text is the table's,** made from what the table says it is
  made from. *Held by `apps/librarian/tests/test_prompt_cases.py`.*
- **Each is sent with a token limit and a temperature of its own:**

  | Prompt | Asked by | Token limit | Temperature |
  |---|---|---|---|
  | `score` | the Matcher's model, in a reference search | 200 | 0.1 |
  | `relationship` | the Gatherer's model, in a gather around an annotation | 150 | 0.3 |
  | `resource-summary` | the Gatherer's model, in either gather | 150 | 0.5 |
  | `reference-suggestions` | the Gatherer's model, in a gather around a resource | 200 | 0.8 |
  | `annotation-summary` | the Gatherer's model, for an annotation's summary | 500 | 0.5 |

  *Held by `apps/librarian/tests/test_prompt_cases.py`.*
- **What a prompt may be given is bounded:** the score prompt lists at most
  twenty candidates and names at most five connected resources; the
  relationship prompt names at most ten connected resources, five citing
  resources and ten sibling entity types; the resource-summary prompt has at
  most the first 2,000 of the resource's text; the reference-suggestions
  prompt at most the first 500 of a stub; and the annotation-summary prompt
  the last 200 before the passage and the first 200 after it. A cut of a
  text counts Unicode code points, and splits no character.
  *Held by `apps/librarian/tests/test_prompt_cases.py`.*

## Order

A Librarian takes every frame of its stream as it is delivered, in the order
of delivery, and hands each request to a lane or begins it at once.

- **A gather takes its turn in a lane of its channel and its resource.**
  Gathers around the annotations of one resource are handled one at a time,
  in the order they arrive, and so are gathers around one resource. Gathers
  of different resources are handled together, and a gather around a
  resource and one around an annotation on it are too.
  *Held by `apps/librarian/tests/test_librarian.py`, and by `librarian/gather`, for gathers around annotations, of one resource and of two.*
- **Reference searches share one lane:** they are handled one at a time, in
  the order they arrive, whatever resource each is of
  ([Known defects](#known-defects)).
  *Held by `apps/librarian/tests/test_librarian.py`.*
- **Text searches, requests for what refers to a resource, summaries and
  limits are each handled as they arrive,** together with whatever else is
  being handled.
  *Held by `apps/librarian/tests/test_librarian.py`.*
- **A signal is noted the moment it is delivered, and waits behind no
  request,** so a gather that is waiting for one is woken while it is in
  hand. *Held by `apps/librarian/tests/test_librarian.py`.*
- **A request that fails is answered on its failure channel, and the
  requests after it are handled.**
  *Held by `apps/librarian/tests/test_librarian.py`.*
- **A reply that cannot be sent is logged, and ends nothing:** whoever asked
  is left to the end of its own wait. *Held by no case.*

## Boot

A Librarian starts in this order: it reads its document, its service account
and each secret its document names; signs in; reaches the graph database,
then the vector index; opens its stream on the bus and begins to take
requests; opens its health port.

- **Everything it is started with is read before anything is dialled:** the
  document first, then the service account, then the graph database's
  password, the embedding provider's key, the Matcher's key and the
  Gatherer's. A Librarian that cannot start on one of them says so in one
  line on its standard error, which begins `[fatal] `, and writes nothing
  else. *Held by `apps/librarian/tests/test_service.py`.*
- **It signs in once, and gives up when the gateway does not answer.** It
  exits with a status other than 0, having said which address did not
  answer. Starting it again is left to whatever supervises it.
  *Held by `librarian/boot`.*
- **It gives up when the graph database or the vector index does not answer
  within sixty seconds,** says which, and exits with a status other than 0.
  *Held by no case.*
- **It reaches no embedding provider and no model at start.** It makes no
  collection, so it has no width of a vector to learn.
  *Held by `apps/librarian/tests/test_service.py`, for a reader of the index that is made with nothing dialled.*
- **It does not look for the state directory.** A state volume that holds no
  directory of the knowledge base is a knowledge base with no views and no
  people: a gather then fails for a resource with no view, and a reply names
  no one. *Held by `apps/librarian/tests/test_record.py`, for a file that is not there.*
- **Every refusal to start ends the process with a status other than 0.**
  *Held by `apps/librarian/tests/test_service.py` and `librarian/boot`.*
- **It loads nothing and makes nothing at start:** no view, no graph and no
  index is read into it, nothing is made in a store
  ([What it answers](#what-it-answers)), and it runs no repair.
  *Held by no case.*

## Health

- **`GET /health`, on the port its document states, answers `200` with a
  JSON object:** `status`; and `actors`, the two it runs, `matcher` and
  `gatherer`. Any other path answers `404`.
  *Held by `apps/librarian/tests/test_service.py`, `packages/service-python/tests/test_health.py` and `librarian/boot`.*
- **The health port opens last,** after the Librarian has begun to take
  requests from the bus. So a Librarian whose health answers is answering. A
  port it cannot take ends it as a refusal to start does.
  *Held by `packages/service-python/tests/test_health.py`, for a port that is held and answers nothing until it is told to.*
- **`status` is `ok` whenever the Librarian answers**
  ([Known defects](#known-defects)). *Held by no case.*

## Stopping

- **On SIGTERM a Librarian takes no more frames, gives up what it has in
  hand, leaves the bus, closes its health port and its connections to the
  vector index and the graph database, and exits with status 0.** It does
  the same on SIGINT.
  *Held by `apps/librarian/tests/test_librarian.py`, for what is given up, and by `librarian/boot`, for the exit and its status.*
- **A gather that is waiting when it stops is let go:** a wait for the graph
  ends as if the signal had come, and a wait for the index ends with no
  decision, uncounted.
  *Held by `apps/librarian/tests/test_progress.py`, `apps/librarian/tests/test_resource_gather.py` and `apps/librarian/tests/test_librarian.py`.*

## Telemetry

- **A Librarian started with `OTEL_EXPORTER_OTLP_ENDPOINT` exports, as
  `semiont-librarian`, exactly what
  [`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json)
  lists for the librarian, and the rows of
  [`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json)
  the first names for it under `sdk`.** Those are what every service says of
  its own process (when it started, how late its loop runs, its memory); a
  span for each frame it sends and each it receives on the bus, and a count
  of the frames it sent; a span for each read of a resource's anchored text;
  a count, the tokens and the duration of each request of a model; and the
  count of gathers that went without something, `semiont.gather.degraded`
  ([The two waits](#the-two-waits)). Every span and metric it exports is one
  of those rows, of the row's kind, carrying only the row's attributes; and
  every one of those rows that its work can make arrives, with every
  attribute the row does not mark as conditional.
  *Held by `librarian/telemetry`.*
- **What is counted of a request of a model is the driver's to count,** the
  same whichever service asks.
  *Held by `packages/inference-python/tests/test_telemetry.py`.*
- **A request is handled in the trace its frame was sent under,** so the
  frames it sends in reply, and the lines it logs, are of that trace.
  *Held by no case.*
- **An event it logs while a span is current carries that span's trace and
  its own id** (`trace_id` and `span_id`), in either form of its log. One
  logged in no span carries neither.
  *Held by `packages/service-python/tests/test_log.py`.*

## Environment

A Librarian's own code reads these from its environment, beside its document,
and no others:

| Variable | What it is |
|---|---|
| `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` | Its service account at the knowledge base's issuer. Required |
| the variables its document names | The graph database's password, required; its embedding provider's key and the key of each actor's model, each for a provider that takes one, and required then. A stack the launcher starts names `NEO4J_PASSWORD` for the first, and gives it the password the launcher keeps. An Ollama takes no key |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The OTLP/HTTP collector its spans and metrics are exported to ([Telemetry](#telemetry)). Without it, and without the console exporter, it exports nothing and writes no span or metric anywhere |
| `OTEL_SERVICE_NAME` | The `service.name` its spans and metrics carry; `semiont-librarian` when unset or empty |
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
line to the service's output for each frame it sends and receives. The
librarian image sets `SUPERVISE_NAME` and `SUPERVISE_PROBE`; the image's
supervisor reads those two and `SEMIONT_SUPERVISE`, and sets
`SUPERVISE_EVENTS`.

What each telemetry variable does is what the Worker service's does
([WORKER-SERVICE.md](./WORKER-SERVICE.md#environment)): the Librarian's code
for it is the Worker's, held to it by `apps/librarian/tests/test_census.py`.

*Held by `librarian/boot`, `librarian/telemetry` and `apps/librarian/tests/test_census.py`.*

## Known defects

Each of these is what today's Librarian does, and is wrong. Another
implementation does not copy them. Each names the module of
`apps/librarian/src/semiont_librarian` it is in.

- **A quote selector is found at the first place the text has its words,**
  whatever its prefix and its suffix say (`window.py`).
- **A gather around an annotation reads the first selector of a list, and no
  other.** An annotation's summary finds a position selector anywhere in the
  list (`window.py`).
- **A resource the Smelter skipped, of a media type that has text, is
  waited for once the Librarian no longer keeps the Smelter's decision of
  it:** a PDF the Smelter declined to derive the text of, or a text of
  white space alone. The index holds no point of it, so a gather of it,
  asked of a Librarian that was started again or has forgotten, waits the
  whole settle bound and is counted as one the index did not settle for
  (`resource_gather.py`).
- **A preview whose bytes cannot be read is the empty string, and nothing
  is logged** (`resource_text.py`).
- **A search that went without a source is logged and not counted.** Only a
  gather has a counter (`reference_search.py`, `text_search.py`).
- **A suggestion's bullet is dropped before the white space that starts its
  line is,** so a bullet after white space is kept; and a line that starts
  with two asterisks loses one (`replies.py`).
- **A reply to the suggestions prompt that is white space alone gives an
  empty list of suggestions, and an empty reply gives none at all**
  (`replies.py`).
- **Reference searches are handled one at a time for the whole knowledge
  base,** so one slow model holds every other search (`librarian.py`).
- **Nothing bounds how many text searches, summaries and requests for what
  refers to a resource are handled together** (`librarian.py`).
- **`status` is `ok` whenever the Librarian answers,** whatever is true of
  the gateway, its stores or its models (`service.py`).

## Not specified here

- **What a store answers when it lags.** A listing, a count of entity types
  and a list of what refers to a resource are each answered as the store
  holds them then. Only a gather waits, and only for the two things
  [The two waits](#the-two-waits) names.
- **Requests that are being handled when it stops.** A Librarian that is
  told to stop does not wait for them, and whoever asked is left to the end
  of its own wait.
- **A model that is slow.** No request of a model has a bound of the
  Librarian's own, but for a limits request.
- **Telemetry of each request.** No span and no metric says how long a
  search or a gather took to answer, nor how many were answered or failed:
  its log says the failures, and what a model cost is the `semiont.inference.*`
  rows.
