"""The Qdrant reader and the Qdrant store: the index in a Qdrant, asked over Qdrant's HTTP API by requests this module makes itself.

No library of Qdrant's is used. Each call is one request, with a JSON body,
to `http://{host}:{port}`. What holds this module's reading of the API is a
real Qdrant under this package's tests (`tests/qdrant_live.py`).

The store makes the two collections `specs/src/vectors/payload-cases.json`
states under `collections`, each with the distance and the payload indexes
stated there. A collection is made only where there is none, as wide as the
embedding provider's vectors: the width is asked for then and at no other
time, so connecting to an index that is there asks no provider anything.
What a point is (its id, its payload, how a stamp and a search result are
read from one) is `semiont_vectors.payload`'s to say.

The reader makes nothing: no collection, no index of a payload member, no
point. It searches as the store does, by the same requests, and is told no
width. A search of a collection that is not there fails, from the reader and
from the store alike, and says the collection is not there: a store makes
its collections when it connects, so a reader that finds none has an index
nobody has started yet, which is no answer to a search.

Every write waits. Qdrant answers a write once it has saved it, and applies
it afterwards, unless the request says `wait=true`. Each write here says it,
so a write that was answered is one the next read sees.

Searching by a resource's own vectors can miss a resource. Each chunk of the
resource asks Qdrant for the points nearest it, four times the limit of
them, and the points are folded to resources afterwards
(`semiont_vectors.merge`). A limit on points is no limit on resources: a
resource with many chunks near the one searched by can take every place of
every answer, and a resource that belongs in the result is then not in it.
The in-memory store scores every point and misses none.

A collection of cosine distance keeps each vector at unit length, so a
vector read back is not the one that was written. It points the same way,
and no cosine changes.

What was read of Qdrant's API: in its reference for the 1.19 line
(https://api.qdrant.tech/api-reference), in its documentation
(https://qdrant.tech/documentation), and, for the members of each body and
of each answer, in the types Qdrant's own JavaScript client of 1.19.0
generates from Qdrant's OpenAPI document.

- A success is answered as `{"result": ..., "status": "ok", "time": ...}`,
  with `usage` beside them. A failure is a status of 4XX or 5XX, whose body
  is `{"status": {"error": "what went wrong"}, "time": ...}`.
- `GET /collections/{name}` answers what a collection is: its `size` and
  `distance` under `config.params.vectors`, and each indexed member's
  `data_type` under `payload_schema`. The reference says a failure is a 4XX,
  and does not say which one a collection that is not there gets. It is 404
  (`Not found: Collection ... doesn't exist!`): that is read from Qdrant's
  issues and not from its reference, and the tests hold it, since they make
  both collections on a Qdrant that has neither. A scroll and a query of a
  collection that is not there are taken to be answered the same way, with a
  404: the reference does not say so either, and the tests hold it, since
  they search a Qdrant that has neither collection.
- `GET /collections` answers `{"collections": [...]}`, each a `name`. It
  changes nothing.
- `PUT /collections/{name}` with `{"vectors": {"size": ..., "distance": ...}}`
  makes a collection, and answers `true`. It takes a `timeout` and no
  `wait`.
- `PUT /collections/{name}/index` with `{"field_name": ..., "field_schema": ...}`
  indexes a payload member, as a `keyword` here. It takes `wait`.
- `PUT /collections/{name}/points` with `{"points": [...]}`, each an `id`, a
  `vector` and a `payload`, puts points: one whose id is there already is
  replaced. An id is a whole number or a UUID. It takes `wait`.
- `POST /collections/{name}/points/delete` with `{"points": [...]}`, which
  are ids, or with `{"filter": ...}`, takes points. It takes `wait`.
- `POST /collections/{name}/points/payload` with `{"payload": ..., "filter": ...}`
  sets the members given on every point the filter holds of, and leaves
  each point's other members as they were. It takes `wait`.
- Each of those four writes answers `{"operation_id": ..., "status": ...}`.
  The status is `acknowledged` (saved, and to be applied), `completed` (the
  change is made) or `wait_timeout`.
- `POST /collections/{name}/points/count` with `{"exact": true}` answers
  `{"count": ...}`.
- `POST /collections/{name}/points/scroll` takes a `limit`, a `filter`, an
  `offset`, `with_payload` (true, false, or the members wanted) and
  `with_vector`. It answers `{"points": [...], "next_page_offset": ...}`:
  the points in the order of their ids, each an `id` with its `payload` and
  its `vector` where asked for, and the id the next page begins at, which is
  given as that page's `offset` and is null on the last page.
- `POST /collections/{name}/points/query` takes a `query`, which is a
  vector, a `limit`, a `score_threshold`, a `filter` and `with_payload`. It
  answers `{"points": [...]}`, each an `id`, a `version`, a `score` and,
  only when asked for, its `payload`. The reference's examples answer the
  best first, which the store rests on and the tests hold. With a threshold
  the points answered score "better than this threshold": by an issue of
  Qdrant's own client, a point that scores exactly the threshold is not
  answered, where the in-memory store answers it.
- `POST /collections/{name}/points/query/batch` with `{"searches": [...]}`,
  each what a query takes, answers a list: one `{"points": [...]}` for each
  search, in the searches' order.
- A filter is `{"must": [...], "must_not": [...]}`: every condition of
  `must` holds of a point it keeps, and none of `must_not`. The condition
  `{"key": ..., "match": {"value": ...}}` holds where the member is that
  value, or is a list with it among its items.
  `{"key": ..., "match": {"any": [...]}}` holds where the member, or any
  item of the list it is, is one of those listed.
"""

from abc import abstractmethod
from collections.abc import AsyncIterator, Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Final, final, override

import httpx
from pydantic import BaseModel, JsonValue, TypeAdapter
from semiont.identifiers import AnnotationId, ResourceId

from semiont_vectors._dimensions import resolve_dimensions
from semiont_vectors.merge import merge_by_resource
from semiont_vectors.payload import (
    STAMP_MEMBERS,
    Payload,
    annotation_key,
    annotation_of,
    annotation_payload,
    chunk_key,
    chunk_payload,
    qdrant_id,
    resource_of,
    result_of,
    stamp_of,
)
from semiont_vectors.store import (
    AnnotationPayload,
    EmbeddingChunk,
    ResourceStamp,
    SearchFilter,
    SearchOptions,
    VectorReader,
    VectorSearchResult,
    VectorStore,
)

__all__ = ["QdrantVectorReader", "QdrantVectorStore"]

type _Body = dict[str, JsonValue]
"""The JSON object a request carries."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class _Collection:
    """A collection as Qdrant is asked to make it. `specs/src/vectors/payload-cases.json` states each, under `collections`."""

    name: str
    distance: str
    """What its vectors are compared by, in Qdrant's word for it."""
    indexes: Mapping[str, str]
    """The payload members Qdrant indexes, and as what, so that a filter on one does not read every point."""

    def at(self, call: str = "") -> str:
        """The path of the collection, or of one of its calls."""
        return f"/collections/{self.name}{call}"


_RESOURCES: Final = _Collection(name="resources", distance="Cosine", indexes={"entityTypes": "keyword", "resourceId": "keyword"})
_ANNOTATIONS: Final = _Collection(name="annotations", distance="Cosine", indexes={"resourceId": "keyword"})
_COLLECTIONS: Final = (_RESOURCES, _ANNOTATIONS)

# How long a request may take. An answer is waited for five minutes: a write is
# answered only once Qdrant has applied it, and the longest of them, indexing a
# payload member of a collection that already holds points, reads every one of
# them first. Reaching the server at all is bounded at ten seconds.
_TIMEOUT: Final = httpx.Timeout(300.0, connect=10.0)

# Said with every write: Qdrant answers once the change is made, and not before.
_WAIT: Final = {"wait": "true"}

# The status Qdrant answers when asked what a collection is that it does not have, or asked to read one.
_NOT_THERE: Final = 404

# How many points each chunk of a resource asks for, for each resource its caller wants: see the module's documentation.
_OVER_FETCH: Final = 4

# How many points one page of a scroll asks for: of payloads, and of vectors, which are the larger.
_PAYLOAD_PAGE: Final = 1000
_VECTOR_PAGE: Final = 256

_OBJECT: Final = TypeAdapter[dict[str, JsonValue]](dict[str, JsonValue])


class _Point(BaseModel, frozen=True):
    """A point as a scroll answers one: its payload and its vector, each where it was asked for."""

    payload: Payload | None = None
    vector: list[float] | None = None


class _Page(BaseModel, frozen=True):
    """One page of a scroll, and the id the next page begins at, which is `None` on the last."""

    points: list[_Point]
    next_page_offset: int | str | None = None


class _Scored(BaseModel, frozen=True):
    """A point as a query answers one that was asked for its payload."""

    score: float
    payload: Payload


class _Found(BaseModel, frozen=True):
    """What one query answers."""

    points: list[_Scored]


class _Counted(BaseModel, frozen=True):
    """What a count answers."""

    count: int


_BATCH: Final = TypeAdapter[list[_Found]](list[_Found])


def _result(response: httpx.Response) -> JsonValue:
    """What Qdrant answered, out of the envelope every answer comes in.

    Raises for an answer that is no success, with its status and its body.
    """
    asked = f"{response.request.method} {response.request.url.path}"
    if not response.is_success:
        raise RuntimeError(f"Qdrant answered {response.status_code} to {asked}: {response.text}")
    answered = _OBJECT.validate_json(response.content)
    if "result" not in answered:
        raise RuntimeError(f"Qdrant's answer to {asked} has no result: {response.text}")
    return answered["result"]


async def _read(client: httpx.AsyncClient, path: str, body: _Body) -> JsonValue:
    """What Qdrant answers a request that changes nothing: a count, a scroll, a query.

    Each is asked of one collection. Where Qdrant answers that the collection
    is not there, the failure says so in words: no store has made it yet.
    """
    response = await client.post(path, json=body)
    if response.status_code == _NOT_THERE:
        raise RuntimeError(f"Qdrant has no such collection (it answered {response.status_code} to POST {path}): no store has made it yet")
    return _result(response)


async def _write(client: httpx.AsyncClient, method: str, path: str, body: _Body) -> None:
    """A write, which Qdrant is told to apply before it answers. Raises where it answers with the change not made."""
    result = _result(await client.request(method, path, json=body, params=_WAIT))
    if not isinstance(result, dict) or result.get("status") != "completed":
        raise RuntimeError(f"Qdrant answered {method} {path} before it had made the change: {result}")


async def _made(client: httpx.AsyncClient, collection: _Collection, dimensions: Callable[[], Awaitable[int]]) -> None:
    """Make a collection where there is none. Only then is anybody asked how wide a vector is."""
    held = await client.get(collection.at())
    if held.status_code != _NOT_THERE:
        _result(held)
        return
    size = await resolve_dimensions(dimensions)
    made = _result(await client.put(collection.at(), json={"vectors": {"size": size, "distance": collection.distance}}))
    if made is not True:
        raise RuntimeError(f"Qdrant did not make the collection {collection.name}: it answered {made}")


async def _pages(client: httpx.AsyncClient, collection: _Collection, asked: _Body) -> AsyncIterator[list[_Point]]:
    """The pages of a scroll, in order, each asked for once the one before it has been read."""
    body: _Body = {**asked}
    while True:
        page = _Page.model_validate(await _read(client, collection.at("/points/scroll"), body))
        yield page.points
        if page.next_page_offset is None:
            return
        body["offset"] = page.next_page_offset


def _said(point: _Point) -> Payload:
    """What a point says of itself. A point answered with no payload says nothing."""
    return {} if point.payload is None else point.payload


def _point(key: str, embedding: Sequence[float], payload: Payload) -> _Body:
    """A point as Qdrant is given one: the id its key is kept under, its vector and its payload."""
    vector: list[JsonValue] = [*embedding]
    return {"id": qdrant_id(key), "vector": vector, "payload": payload}


def _equal(member: str, value: str) -> JsonValue:
    """The condition that a payload's member is `value`, or is a list with `value` in it."""
    return {"key": member, "match": {"value": value}}


def _any_of(member: str, values: Sequence[str]) -> JsonValue:
    """The condition that a payload's member, or an item of the list it is, is one of `values`."""
    listed: list[JsonValue] = [*values]
    return {"key": member, "match": {"any": listed}}


def _points_of(resource_id: ResourceId) -> _Body:
    """The filter that holds of the points that name a resource, and of no others."""
    return {"must": [_equal("resourceId", str(resource_id))]}


def _conditions(stated: SearchFilter | None) -> _Body | None:
    """A search's filter, as Qdrant takes one. `None` where it filters nothing."""
    if stated is None:
        return None
    must: list[JsonValue] = []
    if stated.entity_types:
        must.append(_any_of("entityTypes", stated.entity_types))
    if stated.resource_id is not None:
        must.append(_equal("resourceId", str(stated.resource_id)))
    if stated.motivation is not None:
        must.append(_equal("motivation", stated.motivation))
    must_not: list[JsonValue] = []
    if stated.exclude_resource_id is not None:
        must_not.append(_equal("resourceId", str(stated.exclude_resource_id)))
    if stated.exclude_entity_types:
        must_not.append(_any_of("entityTypes", stated.exclude_entity_types))
    conditions: _Body = {}
    if must:
        conditions["must"] = must
    if must_not:
        conditions["must_not"] = must_not
    return conditions or None


def _query(embedding: Sequence[float], limit: int, options: SearchOptions, conditions: _Body | None) -> _Body:
    """One query's body: the points nearest `embedding`, at most `limit` of them, each with its payload."""
    vector: list[JsonValue] = [*embedding]
    body: _Body = {"query": vector, "limit": limit, "with_payload": True}
    if options.score_threshold is not None:
        body["score_threshold"] = options.score_threshold
    if conditions is not None:
        body["filter"] = conditions
    return body


async def _search(
    client: httpx.AsyncClient, collection: _Collection, embedding: Sequence[float], options: SearchOptions
) -> list[VectorSearchResult]:
    """The points of one collection nearest `embedding`, best first."""
    body = _query(embedding, options.limit, options, _conditions(options.filter))
    found = _Found.model_validate(await _read(client, collection.at("/points/query"), body))
    return [result_of(point.payload, point.score) for point in found.points]


async def _search_alike(client: httpx.AsyncClient, resource_id: ResourceId, options: SearchOptions) -> list[VectorSearchResult]:
    """The resources most like one, best first, by the vectors its own chunks have."""
    own: _Body = {"limit": _VECTOR_PAGE, "filter": _points_of(resource_id), "with_payload": False, "with_vector": True}
    vectors: list[list[float]] = []
    async for page in _pages(client, _RESOURCES, own):
        for point in page:
            if point.vector is None:
                raise RuntimeError(f"Qdrant answered a point of {resource_id} without the vector it was asked for")
            vectors.append(point.vector)
    if not vectors:
        return []

    # The resource itself is never answered, whatever the caller's filter says of it.
    stated = SearchFilter() if options.filter is None else options.filter
    conditions = _conditions(replace(stated, exclude_resource_id=resource_id))
    # One search for each chunk, all in one request. A limit here counts points, and the caller's counts
    # resources, so each asks for more than the caller's: see the module's documentation.
    limit = options.limit
    searches: list[JsonValue] = [_query(vector, limit * _OVER_FETCH, options, conditions) for vector in vectors]
    answered = _BATCH.validate_python(await _read(client, _RESOURCES.at("/points/query/batch"), {"searches": searches}))
    hits = [result_of(point.payload, point.score) for found in answered for point in found.points]
    return merge_by_resource(hits)[:limit]


def _stamps(limit: int) -> _Body:
    """A scroll's body that asks for what a stamp is read from, and for no vector."""
    members: list[JsonValue] = [*STAMP_MEMBERS]
    return {"limit": limit, "with_payload": members, "with_vector": False}


class _QdrantSearches(VectorReader):
    """What the reader and the store share: the way to the Qdrant at `host` and `port`, and the three searches asked over it."""

    def __init__(self, *, host: str, port: int) -> None:
        self._origin: Final = f"http://{host}:{port}"
        self._client: httpx.AsyncClient | None = None

    @abstractmethod
    async def _ready(self, client: httpx.AsyncClient) -> None:
        """Ask the Qdrant what connecting asks of it. Raises where it cannot be reached."""

    @override
    async def connect(self) -> None:
        # The address a caller names is the address asked: no proxy of the environment stands between.
        client = httpx.AsyncClient(base_url=self._origin, timeout=_TIMEOUT, trust_env=False)
        try:
            await self._ready(client)
        except BaseException:
            await client.aclose()
            raise
        previous, self._client = self._client, client
        if previous is not None:
            await previous.aclose()

    @override
    async def disconnect(self) -> None:
        client, self._client = self._client, None
        if client is not None:
            await client.aclose()

    def _reached(self) -> httpx.AsyncClient:
        if self._client is None:
            raise RuntimeError("the Qdrant index is not connected: `connect` it")
        return self._client

    @override
    async def search_resources(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        return await _search(self._reached(), _RESOURCES, embedding, options)

    @override
    async def search_annotations(self, embedding: Sequence[float], options: SearchOptions) -> list[VectorSearchResult]:
        return await _search(self._reached(), _ANNOTATIONS, embedding, options)

    @override
    async def search_by_resource(self, resource_id: ResourceId, options: SearchOptions) -> list[VectorSearchResult]:
        return await _search_alike(self._reached(), resource_id, options)


@final
class QdrantVectorReader(_QdrantSearches):
    """The index in the Qdrant at `host` and `port`, as a service that only searches it asks it.

    It makes nothing in the Qdrant: no collection, no index of a payload
    member, no point. Connecting asks the Qdrant which collections it has,
    which changes nothing, and raises where the Qdrant cannot be reached. A
    reader is told no width, and asks no embedding provider anything.

    A search of a collection that is not there answers no result. The
    service that writes the index makes its collections, and until it has,
    no point is near anything. Qdrant answers a scroll or a query of such a
    collection with the status 404, and that status alone is read so: every
    other failure of a search is raised.
    """

    @override
    async def _ready(self, client: httpx.AsyncClient) -> None:
        _result(await client.get("/collections"))


@final
class QdrantVectorStore(_QdrantSearches, VectorStore):
    """The index in the Qdrant at `host` and `port`, as the service that writes it asks it. See the module's documentation.

    Connecting makes each collection that is not there, and asks for each
    index of a payload member. `dimensions` answers how wide the embedding
    provider's vectors are. It is asked only when a collection must be made.
    """

    def __init__(self, *, host: str, port: int, dimensions: Callable[[], Awaitable[int]]) -> None:
        super().__init__(host=host, port=port)
        self._dimensions: Final = dimensions

    @override
    async def _ready(self, client: httpx.AsyncClient) -> None:
        for collection in _COLLECTIONS:
            await _made(client, collection, self._dimensions)
        # Asked for at every connection: Qdrant takes an index it has already as no failure, and a collection
        # made before one of these members was indexed gets its index here.
        for collection in _COLLECTIONS:
            for member, kind in collection.indexes.items():
                await _write(client, "PUT", collection.at("/index"), {"field_name": member, "field_schema": kind})

    # ── Writes ─────────────────────────────────────────────────────────

    @override
    async def upsert_resource_vectors(
        self,
        resource_id: ResourceId,
        chunks: Sequence[EmbeddingChunk],
        content_checksum: str,
        entity_types: Sequence[str],
        *,
        machine_read: bool,
    ) -> None:
        client = self._reached()
        # Every point the resource had goes first: a resource with fewer chunks than before would keep the rest.
        await self.delete_resource_vectors(resource_id)
        if not chunks:
            return
        points: list[JsonValue] = []
        for chunk in chunks:
            payload = chunk_payload(resource_id, chunk, content_checksum, entity_types, machine_read=machine_read)
            points.append(_point(chunk_key(resource_id, chunk.chunk_index), chunk.embedding, payload))
        await _write(client, "PUT", _RESOURCES.at("/points"), {"points": points})

    @override
    async def update_resource_entity_types(self, resource_id: ResourceId, entity_types: Sequence[str]) -> None:
        client = self._reached()
        types: list[JsonValue] = [*entity_types]
        # Where the filter holds of no point, nothing is set and nothing is made.
        body: _Body = {"payload": {"entityTypes": types}, "filter": _points_of(resource_id)}
        await _write(client, "POST", _RESOURCES.at("/points/payload"), body)

    @override
    async def upsert_annotation_vector(self, embedding: Sequence[float], payload: AnnotationPayload) -> None:
        client = self._reached()
        point = _point(annotation_key(payload.annotation_id), embedding, annotation_payload(payload))
        await _write(client, "PUT", _ANNOTATIONS.at("/points"), {"points": [point]})

    @override
    async def delete_resource_vectors(self, resource_id: ResourceId) -> None:
        await _write(self._reached(), "POST", _RESOURCES.at("/points/delete"), {"filter": _points_of(resource_id)})

    @override
    async def delete_annotation_vector(self, annotation_id: AnnotationId) -> None:
        await _write(self._reached(), "POST", _ANNOTATIONS.at("/points/delete"), {"points": [qdrant_id(annotation_key(annotation_id))]})

    @override
    async def delete_annotation_vectors_for_resource(self, resource_id: ResourceId) -> None:
        await _write(self._reached(), "POST", _ANNOTATIONS.at("/points/delete"), {"filter": _points_of(resource_id)})

    # ── What is indexed ────────────────────────────────────────────────

    @override
    async def count(self) -> int:
        client = self._reached()
        total = 0
        for collection in _COLLECTIONS:
            counted = await _read(client, collection.at("/points/count"), {"exact": True})
            total += _Counted.model_validate(counted).count
        return total

    @override
    async def list_resource_stamps(self) -> dict[ResourceId, ResourceStamp]:
        stamps: dict[ResourceId, ResourceStamp] = {}
        async for page in _pages(self._reached(), _RESOURCES, _stamps(_PAYLOAD_PAGE)):
            for point in page:
                payload = _said(point)
                resource_id = resource_of(payload)
                # Every point of a resource says the same of it: the first one read is its stamp.
                if resource_id is not None and resource_id not in stamps:
                    stamps[resource_id] = stamp_of(payload)
        return stamps

    @override
    async def get_resource_stamp(self, resource_id: ResourceId) -> ResourceStamp | None:
        asked: _Body = {**_stamps(1), "filter": _points_of(resource_id)}
        page = _Page.model_validate(await _read(self._reached(), _RESOURCES.at("/points/scroll"), asked))
        return stamp_of(_said(page.points[0])) if page.points else None

    @override
    async def list_annotation_ids(self) -> set[AnnotationId]:
        asked: _Body = {"limit": _PAYLOAD_PAGE, "with_payload": ["annotationId"], "with_vector": False}
        ids: set[AnnotationId] = set()
        async for page in _pages(self._reached(), _ANNOTATIONS, asked):
            for point in page:
                annotation_id = annotation_of(_said(point))
                if annotation_id is not None:
                    ids.add(annotation_id)
        return ids
