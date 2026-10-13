# semiont-vectors

The vector index [Semiont][semiont]'s Python services write and search, and
the embedding providers that make its vectors, each behind one interface.

It is for whoever writes a Semiont service in Python that keeps the index or
searches it: the Smelter writes it, and the Librarian searches it. A program that only reads and writes a
knowledge base needs the SDK, [`semiont`][sdk-python], and not this package.

It runs on asyncio and requires Python 3.12 or later. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`).

## What an install has

All of it. Qdrant and both providers are asked over HTTP, with `httpx`, so
no database's client and no provider's library is installed, and there is no
extra. Its dependencies are `semiont`, `pydantic` and `httpx`.

| Store | What it is | Run against a server |
| --- | --- | --- |
| `memory` | The index held in the process, for tests | It needs none |
| `qdrant` | A Qdrant, asked over its HTTP API | Yes: every case of both tables |

| Provider | What it is | Run against the real service |
| --- | --- | --- |
| `ollama` | A model served by an Ollama | By a stand-in the tests play over HTTP |
| `voyage` | A model served by Voyage AI | **Never**: by a stand-in written from Voyage's published API |
| `mock` | A vector worked out from the text, for tests | It asks nobody |

## A first use

A provider makes a vector of a text, and a store keeps vectors and finds the
nearest. A store is handed vectors and makes none. A provider is told what a
text is for: `embed_documents` for the texts that are put in an index, and
`embed_query` for a text an index is searched by.

```python
from semiont.identifiers import ResourceId
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.store import EmbeddingChunk, SearchOptions, VectorSearchResult, VectorStore


async def index_and_ask(
    store: VectorStore, provider: EmbeddingProvider, resource_id: ResourceId, texts: list[str], checksum: str, question: str
) -> list[VectorSearchResult]:
    vectors = await provider.embed_documents(texts)
    chunks = [
        EmbeddingChunk(chunk_index=at, text=text, embedding=vector) for at, (text, vector) in enumerate(zip(texts, vectors, strict=True))
    ]
    await store.upsert_resource_vectors(resource_id, chunks, checksum, [], machine_read=False, media_type="text/plain")
    return await store.search_resources(await provider.embed_query(question), SearchOptions(limit=5))
```

A Qdrant store is told where its Qdrant is, and how to learn how wide its
vectors are. It asks that only when it has to make a collection, so a store
that connects to collections that exist asks no provider anything. A store
told to make its index anew asks again.

```python
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorStore


async def connected() -> QdrantVectorStore:
    provider = OllamaEmbeddingProvider(model="nomic-embed-text", base_url="http://localhost:11434")
    store = QdrantVectorStore(host="localhost", port=6333, dimensions=provider.dimensions)
    await store.connect()
    return store
```

A service that only searches the index is handed a reader. A reader has the
three searches and nothing that writes, and it makes nothing in its index:
connecting one to a Qdrant makes no collection. It is told no width and
needs no provider to be made. A search of a collection that nobody has made
yet fails, and says the collection is not there.

```python
from semiont_vectors.qdrant import QdrantVectorReader
from semiont_vectors.store import SearchOptions, VectorReader, VectorSearchResult


async def reading() -> VectorReader:
    reader = QdrantVectorReader(host="localhost", port=6333)
    await reader.connect()
    return reader


async def nearest(reader: VectorReader, vector: list[float]) -> list[VectorSearchResult]:
    return await reader.search_resources(vector, SearchOptions(limit=5))
```

## What is where

Every name is imported from the module that has it. The package's root
exports nothing.

- `semiont_vectors.store`: `VectorReader`, the protocol every reader is
  (`connect`, `disconnect`, `search_resources`, `search_annotations`,
  `search_by_resource`, `get_resource_stamp`); `VectorStore`, the protocol
  every store is, which is a reader's members, the writes and the listings
  of what is indexed, a stamp for each resource and one for each
  annotation; and what their members take and answer. Among the writes are
  `decline_resource`, for a resource whose bytes gave no text, and
  `make_anew`, which empties the index and has it state an `IndexStamp`;
  among the listings, `list_declined`, which answers a `Declined` for each
  such resource, and `index_stamp`.
- `semiont_vectors.payload`: what a point of the index is, and how a
  resource's stamp, an annotation's stamp and a search result are read
  from one.
- `semiont_vectors.merge`: `merge_by_resource`, which folds the chunks a
  search found to one entry for each resource.
- `semiont_vectors.memory`: `MemoryVectorStore`, a store, and so a reader
  too.
- `semiont_vectors.qdrant`: `QdrantVectorStore`, which makes the collections
  and their payload indexes when it connects, and again when it makes the
  index anew, and `QdrantVectorReader`, which makes nothing.
- `semiont_vectors.embedding`: `EmbeddingProvider`, the protocol every
  provider is (`embed_query`, `embed_documents`, `dimensions`), and
  `EmbeddingProviderError`, the failure one raises.
- `semiont_vectors.ollama`, `semiont_vectors.voyage`, `semiont_vectors.mock`:
  one provider each.
- `semiont_vectors.factory`: `create_vector_store`, `create_vector_reader`
  and `create_embedding_provider`, which make the store, the reader and the
  provider a service's configuration document names
  ([`VectorsConfig`][vectors-config], [`EmbeddingConfig`][embedding-config]).

## What the index holds

The index is a projection of a knowledge base's record: a point for each
chunk of a resource's text, and a point for each annotation that quotes
text. One service writes the points and others search them, so what a point
is, and what the index answers after a history of writes, are stated once,
in [`specs/src/vectors/payload-cases.json`][payload-cases] and
[`specs/src/vectors/store-cases.json`][store-cases]. Every store runs both
tables, the Qdrant store against a real Qdrant.

A vector is as wide as the embedding model makes it. The width is measured,
by asking the provider for one vector, and is written down nowhere.

A point does not say which model made its vector, or how its text was cut.
The index says what made its points once, for all of them: its stamp, which
whoever writes the index gives when it has the index made anew
(`make_anew`), and reads back when it starts (`index_stamp`). A store keeps
the stamp whole and reads nothing of it. An index that nothing has made anew
states none, and so does one left half made. Making an index anew takes
everything out of it, and makes it as wide as the provider's vectors are
then.

Every point of a resource's chunks states the checksum of the bytes its text
came from and the media type those bytes were read as, so the same bytes
recorded under another type are told from the ones that were indexed.

A resource whose bytes give no text has no points. So that it is not read
again at every start to learn that, the index remembers it
(`decline_resource`): the checksum of those bytes, the media type they were
read as, and why they gave no text. A resource has points or is remembered
so, and never both, and what is remembered is no point: it is never
searched and is not counted. A Qdrant keeps it in a third collection,
`declined`.

## Asking a provider

A request says what its texts are for where the provider's call has a member
for it: Voyage is sent `input_type`, `query` or `document`, and gives the
same words another vector for each. Ollama's call has none, and the mock
answers a text the same vector either way.

A batch of texts is cut into requests of at most 128 texts. One request at a
time is made of an Ollama and four of Voyage, from one process, however many
callers there are. Each request has fifteen seconds of its own, counted from
when it is sent. A provider that answers 429 or 503 says it is busy, and a
request for documents is made again after one second, then two, then four,
for as long as the wait ends within those fifteen seconds. A query is asked
once: whoever searches is waiting. One request that fails fails its batch,
and the failure says which provider, which model, what status and which
request.

A provider that answers 404 when a collection must be made is taken to be
still fetching its model, and one that cannot be reached to be still
starting: either is asked again, up to twelve times.

## Testing it

```sh
uv sync --locked
uv run pytest                        # needs no server
uv run pytest tests/qdrant_live.py   # against a real Qdrant
```

The second run is told where a Qdrant is by `QDRANT_HOST`. It deletes that
Qdrant's `resources`, `annotations` and `declined` collections before each
case, and fails, and is not skipped, without the variable.

[semiont]: https://github.com/The-AI-Alliance/semiont
[sdk-python]: https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-python
[payload-cases]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/vectors/payload-cases.json
[store-cases]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/vectors/store-cases.json
[vectors-config]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/components/schemas/VectorsConfig.json
[embedding-config]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/components/schemas/EmbeddingConfig.json
