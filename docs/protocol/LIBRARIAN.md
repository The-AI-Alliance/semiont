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
are named. The others are tests of Semiont's own Librarian. A rule marked
"Held by no case" is one nothing checks.
`npm run lint:transport-contract` fails when a case or a test named here does
not exist, and when a case of the suite is named by no rule.

**It owns no store.** Everything a Librarian answers is read from a store
another service writes, or made by a model from what was read. A Librarian
that is stopped and started again has lost nothing. What it writes, it writes
when it starts, in the vector index: each of the index's two collections that
is missing, made empty, and three payload indexes on them ([Boot](#boot)). It
writes no point.
*Held by `librarian/barriers`, for a Librarian that answers a gather and a text search as it did before it was stopped.*

## Settings

A Librarian is told, by whoever starts it: the gateway's address; the issuer
its service account signs in at; its service account; the knowledge base's
name; the graph database (its kind, and what that kind needs to be reached);
the vector index (its kind and where it is); the embedding provider (its kind,
its model and where it is reached); a model for each of its two actors, the
Matcher and the Gatherer (a provider, a model, and what that provider needs to
be reached); the settle bound, which is how long a gather of a resource waits
for the Smelter; the semantic floor, which is the least score a resource needs
to be found by meaning; the Archivist's address; and the state volume, where
the Archivist writes the views.

Told no settle bound, it waits 15,000 milliseconds; told no semantic floor, it
uses 0.6; told the Archivist's host and no port, it uses 24103. It defaults
nothing else.

- **Without the knowledge base's name, the gateway's address, the issuer, a
  graph database, a vector index, an embedding provider, the Archivist's
  address, the state volume, or a model for either actor, it refuses to
  start,** and names what is missing. *Held by `librarian/boot`.*
- **A graph that lives in one process's memory is refused, and so is a vector
  index that does.** Neither could be shared with the service that writes it.
  *Held by `librarian/boot`.*
- **A settle bound that is not a number above 0 is refused, and so is one
  that, with the 875 milliseconds a gather can wait for the graph
  ([The knowledge graph](#the-knowledge-graph)), is not less than the time
  after which a held job is called stalled**
  ([`heldJobStallMs`](../../specs/src/client/timing.json)). The refusal names
  the setting. *Held by `librarian/boot` and `packages/make-meaning/src/__tests__/assert-make-meaning-config.test.ts`.*
- **Its service account is `SEMIONT_OIDC_CLIENT_ID` and
  `SEMIONT_OIDC_CLIENT_SECRET` in its environment** ([Environment](#environment)).
  With either missing it refuses to start, and names both.
  *Held by `librarian/boot`.*
- **A setting that names an environment variable is read from that
  variable.** With the variable unset it refuses to start, and names the
  variable. The graph database's password is told this way.
  *Held by `librarian/boot`.*

## What it answers

A Librarian signs in as its service account and works as the agent `(semiont,
librarian)`: one agent, whatever models its two actors use. It reaches the bus
through the gateway. It reads the graph database and the vector index
directly, the views from the state volume, a resource's bytes from the
Archivist's own `GET /resources/{id}/content`, and a resource's anchored text
from the gateway's `GET /resources/{id}/anchored-text`.

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

  *Held by `packages/make-meaning/src/__tests__/service-pump-roundtrip.test.ts`, and by `librarian/search` and `librarian/gather`, for a result of each of the eight.*
- **A failure of `match:search-requested` carries the request's
  `referenceId`, one of `gather:requested` its `annotationId`, and one of
  `gather:resource-requested` its `resourceId`.**
  *Held by `packages/make-meaning/src/__tests__/matcher.test.ts`, `packages/make-meaning/src/__tests__/gatherer.test.ts`, `librarian/search` and `librarian/gather`.*
- **It follows two signals:** `weave:applied`, by which it knows how far the
  Weaver has applied a resource's events, and `smelt:settled`, by which it
  knows what the Smelter decided of a resource's bytes
  ([The two waits](#the-two-waits)). It follows no recorded event.
  *Held by `packages/make-meaning/src/__tests__/service-channels.test.ts`.*
- **It subscribes to those ten channels and no other, and awaits nothing on
  the bus.** It asks no service a question over the bus: what it needs of
  another service it reads over HTTP, or from a store.
  *Held by `packages/make-meaning/src/__tests__/service-channels.test.ts`.*
- **It records nothing, and puts no node and no edge in the graph, no point
  in the index and nothing in a view.** *Held by no case.*

## Reference search

`match:search-requested` asks what a reference could refer to. The request
carries the reference's resource, the reference, and the gathered context
around it ([Gathering around an annotation](#gathering-around-an-annotation)).
[`score-cases.json`](../../specs/src/librarian/score-cases.json) states each
search as what every source answers and the candidates that follow, and is the
rule; this section says it in prose.

- **The search term is the focus's selected text and its hint, each left out
  when it is absent or empty, joined by one space.**
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for a reference with no hint.*
- **A context whose focus is not an annotation is answered on the failure
  channel, and no source is asked.**
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for the failure and for no embedding and no model being asked.*
- **Four sources are read.** The graph's listing by name, for at most 20
  resources by the term. The graph's listing by entity type, for at most 50
  resources of the context's entity types, and only when the context has any.
  The neighbours: the resources the context's graph connects the request's
  resource to ([The lists read off a graph](#the-lists-read-off-a-graph)).
  The vector index, for at most 40 chunks of resources that score 0.4 or
  more against the embedding of the term, and only when the term is not
  blank. *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for a candidate from each of the four and one embedding of the term.*
- **A neighbour and a vector hit are each read back as a resource from the
  graph, and from the views when the graph has none or its read fails.** One
  neither holds is no candidate.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts` and `packages/make-meaning/src/__tests__/graph-read-grace.test.ts`, and by `librarian/barriers`, for a vector hit the graph does not hold yet.*
- **A listing by name that fails fails the search,** with the failure's
  message. *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **A listing by entity type that fails fails the search too.**
  *Held by no case.*
- **An embedding or an index that fails has answered no hits,** and the
  search goes on with the other sources.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for an embedding that fails.*
- **A resource is one candidate however many sources found it,** and is
  counted as found by each source that answered it.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **The answer is the candidates ordered by score, the highest first.**
  Candidates of one score stay in the order they were found: the listing by
  name, the listing by entity type, the neighbours in the order of the
  graph's edges, the vector index's hits. Each candidate is its resource's
  description with `score` and `matchReason` added.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for the highest score first and what each candidate carries.*
- **When the request states a `limit`, the answer is at most that many of
  the first candidates.**
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts` and `librarian/search`.*

### The score

A candidate's score is the sum of these terms, rounded to two decimals.

- **Entity types,** only when the context and the candidate each have any:
  30 times the types they share divided by the distinct types of both
  together; and, for each shared type, 5 divided by the base-2 logarithm of
  one more than the type's frequency in the context's
  `metadata.entityTypeFrequencies`. A type with no stated frequency counts as
  seen once. *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **Connection:** 20 when the context's graph connects the request's
  resource to the candidate both ways, 10 when it connects it one way.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **Citations,** for a candidate found as a neighbour: 2 for each resource
  that cites the request's resource, 15 at most.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **Name,** the candidate's name and the term compared without regard to the
  case of letters: 25 when they are equal, else 15 when the name begins with
  the term, else 10 when the name has the term in it.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **Recency,** for a candidate that states `dateCreated`: 5 times one less
  the candidate's age in days divided by 30, and nothing from thirty days on.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **Vector index:** 25 times the hit's score.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **Several sources:** 3 for each source that found the candidate, when more
  than one did. *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`.*
- **The reason is what the score was made of, in this order, joined by `; `:**
  `entity types: ` and the shared types, joined by `, `; `bidirectional
  connection` or `connected`; `exact name match`, `prefix name match` or
  `contains name match`; `semantic similarity` for a vector hit; and the
  count of sources followed by ` retrieval sources`, when more than one found
  it. A candidate with none of these has the reason `candidate`.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for the entity types, a connection, a name match and a vector hit.*

### The model's score

- **The Matcher's model is asked once, with the score prompt
  ([The prompts](#the-prompts)), for at most twenty candidates,** unless the
  request states `useSemanticScoring` as false or there is no candidate.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for the one prompt and for none where the request asks for no scoring by a model.*
- **Each score it gives a candidate it was shown adds 25 times that score,**
  and the sum is rounded to two decimals again. A score above 0.5 adds
  `semantic match` to the reason.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for a higher score and the reason.*
- **A reply is read a line at a time, as
  [`reply-cases.json`](../../specs/src/librarian/reply-cases.json) states:**
  a line gives a score when it starts with a candidate's number, a full stop
  and a score from 0 to 1. Every other line gives nothing, and is no error.
  Where two lines score one candidate, the later is read.
  *Held by `packages/make-meaning/src/__tests__/reply-cases.test.ts`.*
- **A model that fails, or whose reply states no score, leaves the scores as
  they were,** and the search is answered.
  *Held by `packages/make-meaning/src/__tests__/score-cases.test.ts`, and by `librarian/search`, for a model that fails.*

## Text search

`match:resources-requested` asks which resources a text finds. The request
carries the text, and may carry `archived`, one `entityType`, an `offset` and
a `limit`.
[`search-cases.json`](../../specs/src/librarian/search-cases.json) states each
search as what each store answers and the page that follows, and is the rule.

- **The text is searched without the white space before and after it. A text
  that is then empty finds nothing, and no store is asked:** the page has no
  resources, a total of 0, and is `lexical`.
  *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts` and `librarian/search`.*
- **Otherwise the graph's listing is asked,** with the text, with `archived`
  and the entity type where they are given, with the offset, which is 0 where
  none is given, and with the limit, which is 50 where none is given. The
  graph applies every filter before it cuts the page, and answers the page
  and the total of all that match.
  *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts` and `librarian/search`.*
- **A graph that fails fails the search,** on the failure channel.
  *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts` and `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts`.*
- **Where the graph's total is more than 0, or the offset is more than 0,
  the page is the graph's and is `lexical`,** and nothing else is asked. Only
  a first page that found nothing is answered by meaning.
  *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts` and `librarian/search`.*
- **Otherwise the text is embedded once, and the vector index is asked for
  four times the page's limit of chunks.** Its hits are folded to one for
  each resource: the hit with the highest score, with that chunk's text.
  *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts`, and by `librarian/search`, for the one embedding and one hit for each resource.*
- **A resource is kept when its score is the semantic floor or more.** The
  kept are ordered by score, the highest first, and by nothing else. `total`
  is how many are kept. *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts` and `librarian/search`.*
- **The first `limit` of the kept are read back, each in turn, from the
  graph, and from the views where the graph has no such resource or fails.**
  One neither has is left out of the page. Each resource of the page carries
  its chunk's text as `content`, and the page is `semantic`, also where
  nothing is kept. *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts`, and by `librarian/search`, for the page and each chunk's text, and `librarian/barriers`, for a resource read from its view.*
- **Where the embedding, the index or a view fails, the answer is the page
  with no resources, a total of 0, and `lexical`.** A search that found
  nothing does not become a failure.
  *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts`, and by `librarian/search`, for an embedding that fails.*
- **Each resource of a lexical page is given a preview as `content`; a
  semantic page's `content` is left as it is.**
  *Held by `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts` and `librarian/search`.*
- **A preview is the first 200 characters of the resource's text, for a
  resource whose bytes are its text;** the bytes are read once, by the
  resource's id. A resource with no stored bytes, one whose text is derived,
  and one that has no text preview as the empty string, and no bytes are
  read. A read that fails previews as the empty string, and the other
  resources keep theirs.
  *Held by `packages/make-meaning/src/__tests__/search-cases.test.ts`, and by `librarian/search`, for a text shorter than 200 characters and for a PDF.*
- **The reply carries the page's resources, `total`, the `offset` and the
  `limit` the search was made with, and `matchKind`,** and its people are
  named ([Names](#names)).
  *Held by `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts` and `librarian/search`.*

## The knowledge graph

Both gathers build the graph around one resource, from the graph database and
the views.
[`knowledge-graph-cases.json`](../../specs/src/librarian/knowledge-graph-cases.json)
states each build as what the stores answer and the graph that follows, or the
failure, and is the rule.

- **The first node is the resource. Then each of its connections is a node
  and an edge from the resource to it,** the edge's `type` `link`, with the
  connection's `bidirectional` flag.
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts`, and by `librarian/gather`, for the resource first and a resource a reference links to.*
- **Then each annotation elsewhere that refers to the resource:** its citing
  resource is a node, named and typed by its view, or named by its id and
  with no entity types where it has no view; the annotation is a node; an
  `annotation-of` edge runs from the annotation to its citing resource, and a
  `cites` edge from the annotation to the resource. An annotation that is on
  the resource itself is not a citation.
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts`.*
- **Then each annotation on the resource is a node, with an `annotation-of`
  edge to the resource.**
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts` and `librarian/gather`.*
- **An annotation's node carries the whole annotation,** with its motivation
  as its label and the entity types its tagging bodies state.
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts`.*
- **A thing is a node once,** and keeps the name it was first given. Each
  connection has its edge all the same.
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts`.*
- **A resource neither the graph database nor the views hold is unknown:**
  the build fails at once, and nothing waits.
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts`.*
- **A resource the views hold and the graph database does not is waited
  for** ([The two waits](#the-two-waits)).
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts` and `librarian/barriers`.*

### The lists read off a graph

[`derive-views-cases.json`](../../specs/src/librarian/derive-views-cases.json)
states what is read off a knowledge graph for a main resource: what it is
connected to, what cites it, and the entity types of the other annotations on
it. The reference search reads the first two from the context it is given,
and the relationship prompt is made from all three.

- **A citation is a `cites` edge to the main resource from an annotation that
  an `annotation-of` edge places on a resource.** That resource cites the
  main resource, once however many of its annotations do.
  *Held by `packages/core/src/__tests__/derive-views-cases.test.ts`.*
- **A connection is any other edge whose source is the main resource,**
  whatever its type, with the name and entity types of its target's node and
  the edge's `bidirectional` flag, which is false where the edge states none.
  *Held by `packages/core/src/__tests__/derive-views-cases.test.ts`.*
- **The sibling entity types are those of the annotation nodes on the main
  resource, but for the focal annotation,** each once.
  *Held by `packages/core/src/__tests__/derive-views-cases.test.ts`.*

## The two waits

A gather reads stores that are written after the record. It waits for each,
within a bound, and nothing else it does waits.

- **It keeps, for each resource, the highest sequence number `weave:applied`
  has signalled, and the last decision `smelt:settled` has signalled.** What
  it keeps is forgotten when it stops, and an entry more than five minutes
  old may be forgotten before that.
  *Held by `packages/make-meaning/src/__tests__/weave-progress.test.ts` and `packages/make-meaning/src/__tests__/smelt-progress.test.ts`.*
- **The wait for the graph.** When the views hold a resource and the graph
  database does not, the build waits at most 500 milliseconds for
  `weave:applied` to reach the sequence number the resource's view states,
  and reads the graph again when it does. If the graph still does not hold
  the resource, or the signal did not come, it reads again after 25 more
  milliseconds, then after 50, 100 and 200 more, and the first read that
  holds the resource ends the wait: 875 milliseconds at most.
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts`, and by `librarian/barriers`, for a wait of 700 milliseconds or more that ends well inside the request's own.*
- **A graph that never comes to hold the resource fails the gather,** with a
  message that says the graph is behind the views and that the resource is
  not missing. It is logged as a warning and counted
  (`semiont.gather.degraded`, `projection` `graph`).
  *Held by `packages/make-meaning/src/__tests__/knowledge-graph-cases.test.ts` and `packages/make-meaning/src/__tests__/graph-context.test.ts`, and by `librarian/barriers`, for the failure and its message.*
- **The wait for the index, which only a gather of a resource makes.** When
  the index holds no vector of the resource, and so answers no match for it,
  and its description states a checksum for its bytes, the gather waits, for
  the settle bound at most, for `smelt:settled` to state a decision of
  exactly that checksum. A decision it already keeps ends the wait at once.
  On `indexed` it asks the index again; on `skipped` it does not.
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts` and `packages/make-meaning/src/__tests__/smelt-progress.test.ts`, and by `librarian/barriers`, for a resource the Smelter then indexes and for one it skips.*
- **An index that does not settle within the bound leaves the context
  without `semanticContext`, and the gather is answered.** It is logged as a
  warning and counted (`semiont.gather.degraded`, `projection` `vectors`).
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts`, and by `librarian/barriers`, for the answer, when it comes and the warning.*
- **The counter has three values of `projection`:** `graph` and `vectors`,
  the two waits that ran out, and `suggestions`, a summary the model failed
  to give ([Gathering around a resource](#gathering-around-a-resource)).
  *Held by `packages/observability/src/__tests__/index.test.ts`, for the first two.*
- **A wait that fails in any way but running out fails the gather.**
  *Held by `packages/make-meaning/src/__tests__/graph-context.test.ts`.*

## Gathering around an annotation

`gather:requested` names an annotation and its resource, and may state
`includeSourceContext` and `includeTargetContext`, each true where it is not
stated, and `contextWindow`, 1,000 where it is not stated. The answer is a
`GatheredContext` whose focus is the annotation. The reads are made in the
order of the rules below.

- **A `contextWindow` less than 100 or more than 5,000 fails the gather,**
  and nothing is read.
  *Held by `packages/make-meaning/src/__tests__/window-cases.test.ts`, and by `librarian/gather`, for a window of 99 and one of 5,001, and no model asked.*
- **The resource's view is read, and the annotation is found in it by its
  id.** A resource with no view, an annotation the view does not hold, and an
  annotation whose target names another resource each fail the gather.
  *Held by `packages/make-meaning/src/__tests__/annotation-context.test.ts`, and by `librarian/gather`, for an annotation the view does not hold.*
- **Where the annotation's body links to a resource, that resource's view is
  read,** and its description is the focus's `targetResource`. A link to a
  resource with no view gives none.
  *Held by `librarian/gather`, for a link to a resource that has a view.*
- **The selected text is cut from the resource's text,** when
  `includeSourceContext` is true. A resource with no stored bytes fails the
  gather. A resource whose text is not there, a PDF the Smelter has not yet
  derived the text of or a media type with none, gives no selected text, and
  the gather goes on.
  *Held by `librarian/gather`, for a text that is there, with and without the option.*
- **A resource's text is its bytes decoded, read from the Archivist, where
  its media type says its bytes are its text; its anchored text, read from
  the gateway, where its text is derived; and nothing where the media type
  has no text**
  ([`specs/src/media-types/registry.json`](../../specs/src/media-types/registry.json)).
  A read of bytes that fails fails the gather.
  *Held by `packages/make-meaning/src/__tests__/resource-context.test.ts`, and by `librarian/gather`, for a text and for a PDF.*
- **The cut is the selection, and `contextWindow` of text before it and after
  it, counted in Unicode code points,** as
  [`window-cases.json`](../../specs/src/librarian/window-cases.json) states.
  A position selector selects from its `start` to its `end`; a quote
  selector selects where the text has its `exact` words. Words the text does
  not have, a target with no selector, and a selector of another kind give
  no selected text, and the gather goes on.
  *Held by `packages/make-meaning/src/__tests__/window-cases.test.ts`, and by `librarian/gather`, for a window of 100 and for none stated.*
- **The linked resource's text is read, when `includeTargetContext` is true
  and it has stored bytes,** and the focus's `targetContext` is the start of
  that text, twice `contextWindow` long, with a summary of the resource from
  the Gatherer's model (the resource-summary prompt).
  *Held by `librarian/gather`, for the option, a text shorter than that, a PDF's text, and the summary.*
- **The knowledge graph of the resource is built**
  ([The knowledge graph](#the-knowledge-graph)), and is the context's
  `graph`. A build that fails fails the gather.
  *Held by `librarian/gather`, for the graph.*
- **The graph database is asked how many resources carry each entity type,**
  and the answer is `metadata.entityTypeFrequencies`. A read that fails
  fails the gather. `metadata.entityTypes` are those the annotation's tagging
  bodies state, `metadata.language` is the resource's, and
  `metadata.resourceType` is `document`.
  *Held by `packages/make-meaning/src/__tests__/annotation-context.test.ts`, and by `librarian/gather`, for the frequencies and the entity types.*
- **Where a selection was cut, the Gatherer's model is asked for the
  relationship sentence** (the relationship prompt), made from the passage
  and the lists read off the graph. A model that fails leaves the context
  without `inferredRelationshipSummary`, and the gather goes on.
  *Held by `packages/make-meaning/src/__tests__/annotation-context.test.ts` and `librarian/gather`.*
- **Where the selected text is not empty, it is embedded, and the vector
  index is asked for at most 10 annotations that score 0.5 or more and are
  on another resource.** Each is named by its resource's view, and one whose
  resource has no view is left out. The matches are `semanticContext`, which
  is absent where there are none. An embedding, an index or a view that
  fails here leaves the context without it, and the gather goes on.
  *Held by `librarian/gather`, for the one embedding, a match on another resource with its name, and none from the annotation's own.*

## Gathering around a resource

`gather:resource-requested` names a resource and states `depth`,
`maxResources`, `includeContent` and `includeSummary`, and may state
`excludeEntityTypes`. The answer is a `GatheredContext` whose focus is the
resource. The reads are made in the order of the rules below.

- **The resource's view is read.** A resource with no view fails the gather.
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts`, `librarian/gather` and `librarian/barriers`.*
- **The resource's text is read when `includeContent` is true,** and is the
  focus's `content.main` where it is not empty. The focus states `content`
  whenever `includeContent` is true, and not otherwise.
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts`, and by `librarian/gather`, for a text and for a PDF.*
- **The knowledge graph of the resource is built,** and is the context's
  `graph`. A build that fails fails the gather.
  *Held by `packages/make-meaning/src/__tests__/gatherer-decoupling.test.ts`, and by `librarian/gather`, for the graph, and `librarian/barriers`, for a build that fails.*
- **The related resources are the first `maxResources` less one of the
  graph's resource nodes, but for the resource itself.** The view of each is
  read, and one with no view is passed by. When `includeContent` is true the
  text of each is read, and `content.related` holds each text that is not
  empty, by resource id. A read of bytes that fails fails the gather.
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts`, and by `librarian/gather`, for how many are read and what is held of each.*
- **When `includeSummary` and `includeContent` are both true and the
  resource's text is not empty, the Gatherer's model is asked:** first for a
  summary (the resource-summary prompt), then for suggestions (the
  reference-suggestions prompt, with the resource's name and its first
  entity type). They are the focus's `summary` and `suggestedReferences`.
  Where `includeSummary` is false the model is asked nothing.
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts` and `librarian/gather`.*
- **A reply to the suggestions prompt is read as
  [`reply-cases.json`](../../specs/src/librarian/reply-cases.json) states:**
  the first three lines that are not empty, each without the bullet that
  starts it. An empty reply gives no suggestions.
  *Held by `packages/make-meaning/src/__tests__/reply-cases.test.ts`, and by `librarian/gather`, for a reply of two lines with no bullet.*
- **A model that fails at either leaves the context with neither, and the
  gather is answered.** It is logged as a warning and counted
  (`semiont.gather.degraded`, `projection` `suggestions`).
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts`, and by `librarian/gather`, for the answer.*
- **The vector index is asked for what is like the resource:** at most
  `maxResources` passages of other resources that score 0.5 or more against
  the resource's own stored vectors, without those of the entity types the
  request excludes. Nothing is embedded. Where the index holds no vector of
  the resource, the gather waits for the index
  ([The two waits](#the-two-waits)).
  *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts`, `librarian/gather` and `librarian/barriers`.*
- **Each match is named by its resource's view, and one whose resource has
  no view is left out.** The matches are `semanticContext`, with the entity
  types that were excluded where any were; it is absent where there are no
  matches. *Held by `packages/make-meaning/src/__tests__/llm-context.test.ts`, and by `librarian/gather`, for the names and the excluded entity types, and `librarian/barriers`, for none.*
- **An index that fails fails the gather.** *Held by no case.*
- **`metadata` states the resource's language and `resourceType`
  `document`,** and no entity types. *Held by no case.*

## An annotation's summary

`gather:summary-requested` names an annotation and its resource.

- **The resource's view is read, the annotation found in it, and the
  resource's text read.** A resource with no view, an annotation the view
  does not hold, a text that is not there, and a target with no position
  selector each fail the request.
  *Held by `librarian/gather`, for an annotation the view does not hold.*
- **The text is cut around the annotation's position, 500 code points on
  each side,** as
  [`window-cases.json`](../../specs/src/librarian/window-cases.json) states.
  *Held by `packages/make-meaning/src/__tests__/window-cases.test.ts`.*
- **The Gatherer's model is asked for the summary** (the annotation-summary
  prompt). A model that fails fails the request.
  *Held by `librarian/gather`, for the one prompt and the model it is sent to.*
- **The answer is the `summary`; `relevantFields`, with the resource's name
  and the annotation's entity types; and `context`:** the last 200 of the
  text before the selection, the selection, and the first 200 of the text
  after it. *Held by `librarian/gather`.*

## What refers to a resource

`gather:referenced-by-requested` names a resource, and may name a
`motivation`.

- **The graph database is asked for the annotations that refer to the
  resource,** of that motivation where one is named. A graph that fails
  fails the request.
  *Held by `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts`, and by `librarian/search`, for the annotations and the motivation.*
- **Each resource those annotations are on is read once, from the graph, and
  from the views where the graph has none or its read fails.**
  *Held by `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts`.*
- **The answer has one entry for each annotation, in the graph's order:** its
  `id`; `resourceName`, the name of the resource it is on; and `target`, with
  that resource as `source` and, as `selector.exact`, the words its quote
  selector states, or the empty string where it has none. Its people are
  named ([Names](#names)).
  *Held by `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts`, and by `librarian/search`, for an entry.*

## Limits

- **`match:limits-requested` is answered with the limits of the Matcher's
  model, and `gather:limits-requested` with those of the Gatherer's:** a list
  of one item, the provider, the model, and the model's `contextTokens`,
  `maxOutputTokens` and, where the provider says, `acceptsTemperature`.
  *Held by `packages/make-meaning/src/__tests__/librarian-decoupling.test.ts`, `packages/make-meaning/src/__tests__/gatherer-decoupling.test.ts` and `librarian/search`.*
- **A provider that has not said within 1.5 seconds, or that fails, leaves
  the list empty, and the request is still answered on its result channel.**
  A later request states the limits once the provider has said them.
  *Held by `packages/inference/src/__tests__/limits-report.test.ts`, and by `librarian/search`, for an answer within 5 seconds.*

## Names

No stored thing carries a person's name. The Archivist keeps what the
knowledge base calls each person in the people projection, on the state
volume.

- **The replies to a text search and to what refers to a resource have their
  people named:** every object whose `@type` is `Person`, wherever in the
  reply it is, and whose `@id` the projection holds, has its `name` set to
  the name stated there, in place of any it carried. Nothing else of the
  reply changes, as
  [`naming-cases.json`](../../specs/src/librarian/naming-cases.json) states.
  *Held by `packages/make-meaning/src/__tests__/naming-cases.test.ts`, and by `librarian/search`, for a text search's lexical page and its semantic one.*
- **The projection is read once for each reply.** A knowledge base with no
  projection names no one.
  *Held by `packages/make-meaning/src/__tests__/views/people-reader.test.ts` and `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts`.*
- **A projection that cannot be read is logged as a warning, and the reply
  is sent with no one named.** *Held by no case.*
- **The replies to the two gathers, to a summary and to the two limits
  requests are not named.** *Held by no case.*

## The prompts

A Librarian sends a model five prompts.
[`prompt-cases.json`](../../specs/src/librarian/prompt-cases.json) states what
each is made from and its text to the last character, and is the rule.

- **Each prompt's text is the table's,** made from what the table says it is
  made from. *Held by `packages/make-meaning/src/__tests__/prompt-cases.test.ts`.*
- **Each is sent with a token limit and a temperature of its own:**

  | Prompt | Asked by | Token limit | Temperature |
  |---|---|---|---|
  | `score` | the Matcher's model, in a reference search | 200 | 0.1 |
  | `relationship` | the Gatherer's model, in a gather around an annotation | 150 | 0.3 |
  | `resource-summary` | the Gatherer's model, in either gather | 150 | 0.5 |
  | `reference-suggestions` | the Gatherer's model, in a gather around a resource | 200 | 0.8 |
  | `annotation-summary` | the Gatherer's model, for an annotation's summary | 500 | 0.5 |

  *Held by `packages/make-meaning/src/__tests__/prompt-cases.test.ts`.*
- **What a prompt may be given is bounded:** the score prompt lists at most
  twenty candidates and names at most five connected resources; the
  relationship prompt names at most ten connected resources, five citing
  resources and ten sibling entity types; the resource-summary prompt has at
  most the first 2,000 of the resource's text; the reference-suggestions
  prompt at most the first 500 of a stub; and the annotation-summary prompt
  the last 200 before the passage and the first 200 after it.
  *Held by `packages/make-meaning/src/__tests__/prompt-cases.test.ts`.*

## Order

- **Gathers around the annotations of one resource are handled one at a
  time, in the order they arrive, and so are gathers around one resource.**
  Gathers of different resources are handled together, and a gather around a
  resource and one around an annotation on it are too.
  *Held by `librarian/gather`, for gathers around annotations, of one resource and of two.*
- **Text searches, requests for what refers to a resource, summaries and
  limits are each handled as they arrive,** together with whatever else is
  being handled. *Held by no case.*
- **A request that fails is answered on its failure channel, and the
  requests after it are handled.**
  *Held by `packages/make-meaning/src/__tests__/matcher.test.ts`, `packages/make-meaning/src/__tests__/gatherer.test.ts` and `packages/make-meaning/src/__tests__/handlers/resource-retrieval.test.ts`.*

## Boot

A Librarian starts in this order: it reads its settings; signs in; finds the
views on the state volume; reaches the graph database, the embedding provider
and the vector index; starts its two actors and its handlers; begins to take
requests from the bus; opens its health port.

- **Where the vector index lacks either of its two collections, `resources`
  and `annotations`, the Librarian makes it, empty,** as wide as the
  embedding model's vectors, which it learns by asking the provider to embed
  once. It asks the provider nothing at start where both are there.
  *Held by no case.*
- **At every start it asks the vector index for three keyword payload
  indexes:** on `entityTypes` and on `resourceId` of `resources`, and on
  `resourceId` of `annotations`. Where one is there already, nothing
  changes, and an index that refuses one does not keep the Librarian from
  starting. *Held by no case.*
- **It gives up when the gateway does not answer.** It tries to sign in a
  bounded number of times, then exits with a status other than 0, having said
  which address did not answer. *Held by `librarian/boot`.*
- **It gives up when the graph database, the embedding provider or the vector
  index does not answer within a minute,** and exits with a status other than
  0. *Held by no case.*
- **Every refusal to start ends the process with a status other than 0.**
  The state volume is looked for after it has signed in, and the Archivist's
  address and the two models after it has reached its stores, so a Librarian
  that cannot sign in does not come to refuse them.
  *Held by `librarian/boot`.*
- **It loads nothing at start:** no view, no graph and no index is read into
  it, and it runs no repair. What it makes in the vector index is above.
  *Held by no case.*

## Health

- **`GET /health`, on port 24104, answers `200` with a JSON object:**
  `status`; and `actors`, the two it runs, `matcher` and `gatherer`. Any
  other path answers `404`. *Held by `librarian/boot`.*
- **The health port opens last,** after the Librarian has begun to take
  requests from the bus. So a Librarian whose health answers is answering.
  *Held by no case.*

## Stopping

- **On SIGTERM a Librarian stops taking requests, leaves the bus, closes its
  connection to the graph database and its health port, and exits with
  status 0.** It does the same on SIGINT.
  *Held by `librarian/boot`, for the exit and its status.*
- **A gather that is waiting when it stops is let go:** a wait for the graph
  ends as if the signal had come, and a wait for the index ends with no
  decision, uncounted. *Held by `packages/make-meaning/src/__tests__/weave-progress.test.ts` and `packages/make-meaning/src/__tests__/smelt-progress.test.ts`.*

## Telemetry

No row of
[`specs/src/service-telemetry/telemetry.json`](../../specs/src/service-telemetry/telemetry.json)
or of
[`specs/src/sdk-telemetry/telemetry.json`](../../specs/src/sdk-telemetry/telemetry.json)
is the Librarian's. What it exports is listed for operators in
[OBSERVABILITY.md](../operator/administration/OBSERVABILITY.md#metrics).

- **A Librarian started with `OTEL_EXPORTER_OTLP_ENDPOINT` exports, as
  `semiont-librarian`, spans and metrics.** Of its process:
  `semiont.process.start_time`, `semiont.process.restarts` where it is
  supervised, `semiont.process.abnormal_exit`,
  `semiont.runtime.event_loop.lag` and `semiont.runtime.heap`. Of the bus: a
  span `bus.recv:<channel>` for each frame it receives, a span
  `bus.emit:<channel>` for each it sends, and the count `semiont.bus.sent`.
  Of its work: a span `actor.<actor>:<channel>` and the duration
  `semiont.handler.duration`, with `actor` and `bus.channel`, for each
  reference search, each gather of either kind, each text search and each
  request for what refers to a resource; `semiont.inference.calls`,
  `semiont.inference.tokens` and `semiont.inference.duration` for each
  request of a model; a span `content.get_anchored_text` for each read of a
  resource's anchored text; and `semiont.gather.degraded`
  ([The two waits](#the-two-waits)). *Held by no case.*
- **A summary and a limits request have no span and no duration of their
  own.** *Held by no case.*
- **A line it logs while a span is current carries that span's trace and its
  own id** (`trace_id` and `span_id`), in either form of its log. One logged
  in no span carries neither.
  *Held by `packages/observability/src/__tests__/process-logger.test.ts`.*

## Environment

A Librarian's own code reads these from its environment, and no others:

| Variable | What it is |
|---|---|
| `SEMIONT_OIDC_CLIENT_ID`, `SEMIONT_OIDC_CLIENT_SECRET` | Its service account at the knowledge base's issuer. Required |
| `XDG_STATE_HOME` | The state volume. The views are under `semiont/<the knowledge base's name>` in it. Required |
| `HOME` | The directory its settings are read from |
| the variables its settings name | A setting may name a variable in place of a value, and each one named is required. A stack the launcher starts names `GATEWAY_HOST`, the gateway's address, and `NEO4J_PASSWORD`, the graph database's password, and gives it both, with a key for each provider that takes one |
| `LOG_LEVEL` | The least level it logs; `info` when unset |
| `LOG_FORMAT` | Set to `simple`, it logs lines for a person to read. Otherwise each line is a JSON object |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | The OTLP/HTTP collector its spans and metrics are exported to ([Telemetry](#telemetry)). Without it, and without the console exporter, it exports nothing |
| `OTEL_SERVICE_NAME` | The `service.name` its spans and metrics carry; `semiont-librarian` when unset |
| `OTEL_SDK_DISABLED` | Set to `true`, it exports nothing, whatever else is set |
| `OTEL_CONSOLE_EXPORTER` | Set to `true`, with no endpoint, it writes spans and metrics to its output instead of exporting them |
| `OTEL_METRICS_EXPORTER` | Set to `console`, it writes metrics to its output, while spans still go to the endpoint |
| `OTEL_METRIC_EXPORT_INTERVAL` | The milliseconds between metric exports; 30000 when unset |
| `SUPERVISE_EVENTS`, `SUPERVISE_NAME` | The supervisor's events log, one `starting <name>` line for each life of the process, and that name. With both, it reports `semiont.process.restarts`. Without either, the metric does not exist |
| `SEMIONT_BUS_LOG` | With any value that is not empty, it writes a line to its output for each frame it sends and receives |

The libraries it is built on read some unasked: its OpenTelemetry SDK and
exporter read the standard variables they read on their own. The librarian
image sets `NODE_ENV`, which the Librarian's own code does not read, and
`SUPERVISE_NAME`. `SEMIONT_SUPERVISE` and `SUPERVISE_PROBE` are read by the
image's supervisor, which sets `SUPERVISE_EVENTS`, and not by the Librarian.

*Held by `librarian/boot`, for the service account and the variable a setting names.*

## Known defects

Each of these is what today's Librarian does, and is wrong. None is a rule,
no case holds one, and another implementation does not copy them.

- **The model is shown the first twenty candidates found, and not the twenty
  with the highest scores.** The candidates are ordered by score only after
  the model has been asked.
- **An empty search term gives every candidate with a name a prefix name
  match:** every name begins with the empty text.
- **An entity type whose stated frequency is 0 gives an infinite score.**
- **A `dateCreated` in the future scores more than 5 for recency, and one
  that cannot be read as a date leaves the whole score not a number.**
- **A reference search with `limit: 0` answers every candidate.**
- **The citation term counts the resources that cite the request's
  resource,** and so is the same for every neighbour. It says nothing of the
  candidate.
- **Several vector hits for one resource keep the score of the last hit the
  index answered,** in a reference search.
- **A quote selector is found at the first place the text has its words,**
  whatever its prefix and its suffix say.
- **A gather around an annotation reads the first selector of a list, and no
  other.** An annotation's summary finds a position selector anywhere in the
  list.
- **The cuts at 200, at 500 and at 2,000 count UTF-16 code units,** and so
  does the cut of a linked resource's text in a gather. Each can split a
  character outside the Basic Multilingual Plane in two.
- **An annotation's summary states no `resourceId` in `relevantFields`:** it
  reads a member `id`, which no resource's description has. The member is
  `@id`.
- **The score prompt's line for a comment or an assessment is the first item
  of the annotation's body,** whatever that item's purpose is.
- **A score a model writes as `0.8.5` is read as 0.8.**
- **A suggestion's bullet is dropped before the white space that starts its
  line is,** so a bullet after white space is kept.
- **A citing resource with no description, or with an empty name, is named
  `Untitled Resource`** in the answer to what refers to a resource.
- **A person whose `@id` is the name of something every object has, such as
  `constructor`, is given a name the people projection never stated.**
- **Reference searches are handled one at a time for the whole knowledge
  base,** so one slow model holds every other search.
- **Nothing bounds how many text searches and requests for what refers to a
  resource are handled together.**
- **`status` is `ok` whenever the Librarian answers,** whatever is true of
  the gateway, its stores or its models.
- **The bound on `contextWindow`, 100 to 5,000, is in no schema.** A request
  outside it is valid on the bus and fails in the Librarian.
- **A citing resource's view is read though the resource is already a node
  of the graph,** and the name read is not used.
- **The wait for the index begins whenever the index answers no match for
  the resource, and not only when it holds no vector of it.** A resource
  that is indexed and has nothing like it, and one the Smelter skipped, are
  each answered without a wait only while the Librarian still keeps the
  Smelter's decision of them. Once it has been started again, or has forgotten the
  decision, which it may after five minutes, a gather of such a resource
  waits the whole settle bound, and is logged and counted as one the index
  did not settle for.
- **A text search logs nothing when it reads a resource from its view
  because the graph does not hold it.** A reference search and a request for
  what refers to a resource each log it.
- **A model that fails on the summary of a linked resource fails the whole
  gather around an annotation.** A model that fails on the relationship
  sentence does not.
- **A gather around a resource that asks for a summary and not for content
  asks the model nothing, and answers no summary and no suggestions.** The
  summary is made from the text, and the text is read only for
  `includeContent`.
- **A reference's own resource is not left out of its candidates.** A
  listing or the index that answers it makes it a candidate like any other.
- **The reply to a reference search has no one named** ([Names](#names)),
  where the replies to a text search and to what refers to a resource do.
- **A request for what refers to a resource no one made is answered with an
  empty list,** as one is for a resource nothing refers to.
- **A text search with `limit: 0` is not a page of nothing.** The graph is
  asked with a limit of 0, and the graph database then answers a page of
  its own length, which is 20 in Neo4j; the reply states the `limit` as 0.
- **The handler of `gather:summary-requested` is never taken off the bus
  when a Librarian stops:** it ends only when the Librarian's own bus is
  closed, after its actors have stopped. The vector index's client is never
  disconnected.

## Not specified here

- **`depth`.** A gather around a resource must state it, and nothing reads
  it: the graph is the resource's own neighbourhood, one link out.
- **What the graph's listing matches.** Which resources a text finds by
  name, and in what order, is the graph database's query and not stated
  here; [flows/MATCH.md](./flows/MATCH.md) says it for a client.
- **What a store answers when it lags.** A listing, a count of entity types
  and a list of what refers to a resource are each answered as the store
  holds them then. Only a gather waits, and only for the two things
  [The two waits](#the-two-waits) names.
- **Requests that are being handled when it stops.** A Librarian that is
  told to stop does not wait for them, and whoever asked is left to the end
  of its own wait.
- **A model that is slow.** No request of a model has a bound of the
  Librarian's own, but for a limits request.
- **Telemetry tables.** What a Librarian exports is in neither telemetry
  table, so nothing holds it to a row.
