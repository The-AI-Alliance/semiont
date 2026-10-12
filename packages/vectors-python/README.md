# semiont-vectors

The vector index [Semiont][semiont]'s Python services write and search, and
the embedding providers that make its vectors, each behind one interface.

It is for whoever writes a Semiont service in Python that keeps the index or
searches it: the Smelter first. A program that only reads and writes a
knowledge base needs the SDK, [`semiont`][sdk-python], and not this package.

It runs on asyncio and requires Python 3.12 or later. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`). It is the Python counterpart of [`@semiont/vectors`][vectors-typescript].

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
nearest. A store is handed vectors and makes none.

```python
from semiont.identifiers import ResourceId
from semiont_vectors.embedding import EmbeddingProvider
from semiont_vectors.store import EmbeddingChunk, SearchOptions, VectorSearchResult, VectorStore


async def index_and_ask(
    store: VectorStore, provider: EmbeddingProvider, resource_id: ResourceId, texts: list[str], checksum: str, question: str
) -> list[VectorSearchResult]:
    vectors = await provider.embed_batch(texts)
    chunks = [
        EmbeddingChunk(chunk_index=at, text=text, embedding=vector) for at, (text, vector) in enumerate(zip(texts, vectors, strict=True))
    ]
    await store.upsert_resource_vectors(resource_id, chunks, checksum, [], machine_read=False)
    return await store.search_resources(await provider.embed(question), SearchOptions(limit=5))
```

A Qdrant store is told where its Qdrant is, and how to learn how wide its
vectors are. It asks that only when it has to make a collection, so a store
that connects to collections that exist asks no provider anything.

```python
from semiont_vectors.ollama import OllamaEmbeddingProvider
from semiont_vectors.qdrant import QdrantVectorStore


async def connected() -> QdrantVectorStore:
    provider = OllamaEmbeddingProvider(model="nomic-embed-text", base_url="http://localhost:11434")
    store = QdrantVectorStore(host="localhost", port=6333, dimensions=provider.dimensions)
    await store.connect()
    return store
```

## What is where

Every name is imported from the module that has it. The package's root
exports nothing.

- `semiont_vectors.store`: `VectorStore`, the protocol every store is, and
  what its members take and answer.
- `semiont_vectors.payload`: what a point of the index is, and how a stamp
  and a search result are read from one.
- `semiont_vectors.merge`: `merge_by_resource`, which folds the chunks a
  search found to one entry for each resource.
- `semiont_vectors.memory`, `semiont_vectors.qdrant`: one store each.
- `semiont_vectors.embedding`: `EmbeddingProvider`, the protocol every
  provider is, and `EmbeddingProviderError`, the failure one raises.
- `semiont_vectors.ollama`, `semiont_vectors.voyage`, `semiont_vectors.mock`:
  one provider each.

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

## Asking a provider

A batch of texts is cut into requests of at most 128 texts. One request at a
time is made of an Ollama and four of Voyage, from one process, however many
callers there are. Each request has fifteen seconds of its own, counted from
when it is sent. One request that fails fails its batch, and the failure
says which provider, which model, what status and which request.

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
Qdrant's `resources` and `annotations` collections before each case, and
fails, and is not skipped, without the variable.

[semiont]: https://github.com/The-AI-Alliance/semiont
[sdk-python]: https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-python
[vectors-typescript]: https://github.com/The-AI-Alliance/semiont/tree/main/packages/vectors
[payload-cases]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/vectors/payload-cases.json
[store-cases]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/vectors/store-cases.json
