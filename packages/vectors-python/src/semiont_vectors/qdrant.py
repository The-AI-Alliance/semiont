"""The Qdrant reader and the Qdrant store: the index in a Qdrant, asked over Qdrant's HTTP API by requests this module makes itself.

No library of Qdrant's is used. Each call is one request, with a JSON body,
to `http://{host}:{port}`. What holds this module's reading of the API is a
real Qdrant under this package's tests (`tests/qdrant_live.py`).

The store makes the three collections `specs/src/vectors/payload-cases.json`
states under `collections`, each with the distance and the payload indexes
stated there. Two hold the points that are searched, and are as wide as the
embedding provider's vectors. Connecting makes a collection only where there
is none, and the width is asked for only then, so connecting to an index
that is there asks no provider anything. Making the index anew deletes every
collection and makes each again, and asks for the width again. What a point
of those two is (its id, its payload, how a stamp and a search result are
read from one) is `semiont_vectors.payload`'s to say.

The third collection, `declined`, is what the index remembers of each
resource whose bytes gave no text to index. Its points hold no text and are
never searched. Each is kept under the id made of its resource's id alone,
and its payload is that resource's id, the checksum, the media type and the
reason. Qdrant keeps a point by a vector, so the collection is one number
wide and each of its points has the vector `[0.0]`, which says nothing. It
is compared by the dot product: a collection of cosine distance keeps each
vector at unit length, and a vector of 0 has none.

What made the index's points, its stamp, is in the metadata of each of the
two collections that are searched, as `{"stamp": ...}`, written when the
collection is made anew. A collection made because there was none states no
stamp, and `declined` never states one. The index states a stamp only where
both state the same one, so an index left half made anew states none.

The reader makes nothing: no collection, no index of a payload member, no
point. It searches as the store does, by the same requests, and is told no
width. A search of a collection that is not there fails, from the reader and
from the store alike, and says the collection is not there: a store makes
its collections when it connects, so a reader that finds none has an index
nobody has started yet, which is no answer to a search.

Every write waits. Qdrant answers a write once it has saved it, and applies
it afterwards, unless the request says `wait=true`. Each write here says it,
so a write that was answered is one the next read sees.

Searching by a resource's own vectors is cut to its limit in resources, and
not in points. Each chunk of the resource asks Qdrant for the points nearest
it grouped by the resource each is of, one point to a group and as many
groups as the caller's limit: the best point of each of the nearest
resources. A resource with many chunks near the one searched by is then one
group, and takes one place. The answers of the chunks are folded to one for
each resource (`semiont_vectors.merge`) and cut to the limit. A resource
that belongs in the result is among the nearest resources of the chunk it is
nearest to, so it is in the result, as far as Qdrant's grouping is whole:
Qdrant's documentation calls the number of groups it answers a best effort.
The in-memory store scores every point, and misses none.

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
  `distance` under `config.params.vectors`, each indexed member's
  `data_type` under `payload_schema`, and its `metadata` under `config`,
  which is absent or null for a collection that was given none. The
  reference says a failure is a 4XX, and does not say which one a
  collection that is not there gets. It is 404
  (`Not found: Collection ... doesn't exist!`): that is read from Qdrant's
  issues and not from its reference, and the tests hold it, since they make
  the collections on a Qdrant that has none of them. A scroll and a query of a
  collection that is not there are taken to be answered the same way, with a
  404: the reference does not say so either, and the tests hold it, since
  they search a Qdrant that has neither collection.
- `GET /collections` answers `{"collections": [...]}`, each a `name`. It
  changes nothing.
- `PUT /collections/{name}` with `{"vectors": {"size": ..., "distance": ...}}`
  makes a collection, and answers `true`. It takes a `timeout` and no
  `wait`. A `distance` is `Cosine`, `Euclid`, `Dot` or `Manhattan`. A `size`
  is a whole number, and the types state no least one: that a collection
  may be 1 wide, and keep a vector of 0, is held by the tests. The body may
  state `metadata`, an object of any JSON, which the types say is for
  whatever an application has to say of a collection, such as which model
  made its vectors. The types do not say since which Qdrant a collection
  has it.
- `DELETE /collections/{name}` deletes a collection and all that is in it,
  and answers a boolean. It takes a `timeout` and no `wait`. The types do
  not say what it answers for a collection that is not there, so the store
  deletes only a collection that `GET` says is there, and takes `true`
  alone to mean it is gone.
- `PATCH /collections/{name}` with `{"metadata": ...}` puts the members
  given into a collection's metadata, beside those it has. The store never
  asks it: the tests do, to make two collections state different stamps.
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
- `POST /collections/{name}/points/query/groups` takes what a query takes
  and, beside it, `group_by`, the payload member whose value a group is of,
  which is a string or an integer, and `group_size`, the most points
  answered of one group. Its `limit` is the most groups, and
  not the most points. It answers `{"groups": [...]}`, each an `id`, which
  is the member's value, and its `hits`, each what a query answers of a
  point. The documentation says the groups come in the order of each one's
  best point, which the store does not rest on: it folds and sorts what it
  is answered. There is no call that asks several of these at once.
- A filter is `{"must": [...], "must_not": [...]}`: every condition of
  `must` holds of a point it keeps, and none of `must_not`. The condition
  `{"key": ..., "match": {"value": ...}}` holds where the member is that
  value, or is a list with it among its items.
  `{"key": ..., "match": {"any": [...]}}` holds where the member, or any
  item of the list it is, is one of those listed. The condition
  `{"has_id": [...]}` holds of a point kept under one of the ids listed,
  and reads no payload.
"""

import asyncio
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
    ANNOTATION_STAMP_MEMBERS,
    STAMP_MEMBERS,
    Payload,
    annotation_key,
    annotation_of,
    annotation_payload,
    annotation_stamp_of,
    chunk_key,
    chunk_payload,
    qdrant_id,
    resource_of,
    result_of,
    stamp_of,
)
from semiont_vectors.store import (
    AnnotationPayload,
    AnnotationStamp,
    CollectionAbsent,
    Declined,
    EmbeddingChunk,
    IndexStamp,
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
    size: int | None
    """How wide its vectors are, where that is fixed. `None` for a collection as wide as the embedding provider's vectors."""

    def at(self, call: str = "") -> str:
        """The path of the collection, or of one of its calls."""
        return f"/collections/{self.name}{call}"


_RESOURCES: Final = _Collection(name="resources", distance="Cosine", indexes={"entityTypes": "keyword", "resourceId": "keyword"}, size=None)
_ANNOTATIONS: Final = _Collection(name="annotations", distance="Cosine", indexes={"resourceId": "keyword"}, size=None)
# What the index remembers of each declined resource, which nothing searches: see the module's documentation.
_DECLINED: Final = _Collection(name="declined", distance="Dot", indexes={}, size=1)
_COLLECTIONS: Final = (_RESOURCES, _ANNOTATIONS, _DECLINED)
# The collections of the embedding provider's vectors: the ones whose points are counted, and the ones that state the index's stamp.
_EMBEDDED: Final = tuple(collection for collection in _COLLECTIONS if collection.size is None)

# The vector of every point of the declined. It says nothing: Qdrant keeps a point by a vector, and nothing searches these.
_NOTHING: Final = (0.0,)

# How long a request may take. An answer is waited for five minutes: a write is
# answered only once Qdrant has applied it, and the longest of them, indexing a
# payload member of a collection that already holds points, reads every one of
# them first. Reaching the server at all is bounded at ten seconds.
_TIMEOUT: Final = httpx.Timeout(300.0, connect=10.0)

# Said with every write: Qdrant answers once the change is made, and not before.
_WAIT: Final = {"wait": "true"}

# The status Qdrant answers when asked what a collection is that it does not have, or asked to read one.
_NOT_THERE: Final = 404

# How many chunks of a resource ask at once for the resources nearest them: each is a request of its own.
_ALIKE_AT_ONCE: Final = 8

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


class _Config(BaseModel, frozen=True):
    """A collection's configuration, read for its metadata alone, which is absent or null where the collection was given none."""

    metadata: dict[str, JsonValue] | None = None


class _Described(BaseModel, frozen=True):
    """What Qdrant answers a collection is, read for its configuration alone."""

    config: _Config


class _Group(BaseModel, frozen=True):
    """One group of a grouped query: the points of one resource that it answers, the best first."""

    hits: list[_Scored]


class _Grouped(BaseModel, frozen=True):
    """What a grouped query answers."""

    groups: list[_Group]


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
        answered = f"it answered {response.status_code} to POST {path}"
        raise CollectionAbsent(f"Qdrant has no such collection ({answered}): no store has made it yet")
    return _result(response)


async def _write(client: httpx.AsyncClient, method: str, path: str, body: _Body) -> None:
    """A write, which Qdrant is told to apply before it answers. Raises where it answers with the change not made."""
    result = _result(await client.request(method, path, json=body, params=_WAIT))
    if not isinstance(result, dict) or result.get("status") != "completed":
        raise RuntimeError(f"Qdrant answered {method} {path} before it had made the change: {result}")


async def _there(client: httpx.AsyncClient, collection: _Collection) -> bool:
    """Whether Qdrant has a collection. Raises for an answer that says neither that it has it nor that it has none."""
    held = await client.get(collection.at())
    if held.status_code == _NOT_THERE:
        return False
    _result(held)
    return True


async def _make(client: httpx.AsyncClient, collection: _Collection, size: int, stamp: IndexStamp | None) -> None:
    """Make a collection that is not there, `size` numbers wide. Its metadata states `stamp`, where it is given one."""
    body: _Body = {"vectors": {"size": size, "distance": collection.distance}}
    if stamp is not None:
        stated: _Body = {**stamp}
        metadata: _Body = {"stamp": stated}
        body["metadata"] = metadata
    made = _result(await client.put(collection.at(), json=body))
    if made is not True:
        raise RuntimeError(f"Qdrant did not make the collection {collection.name}: it answered {made}")


async def _made(client: httpx.AsyncClient, collection: _Collection, dimensions: Callable[[], Awaitable[int]]) -> None:
    """Make a collection where there is none. It states no stamp.

    Only then is anybody asked how wide a vector is, and only for a
    collection as wide as the provider's vectors.
    """
    if await _there(client, collection):
        return
    size = collection.size if collection.size is not None else await resolve_dimensions(dimensions)
    await _make(client, collection, size, None)


async def _dropped(client: httpx.AsyncClient, collection: _Collection) -> None:
    """Delete a collection that is there, and every point of it. One that is not there is left so."""
    if not await _there(client, collection):
        return
    dropped = _result(await client.delete(collection.at()))
    if dropped is not True:
        raise RuntimeError(f"Qdrant did not delete the collection {collection.name}: it answered {dropped}")


async def _indexed(client: httpx.AsyncClient) -> None:
    """Ask for each index of a payload member, of every collection. Qdrant takes an index it has already as no failure."""
    for collection in _COLLECTIONS:
        for member, kind in collection.indexes.items():
            await _write(client, "PUT", collection.at("/index"), {"field_name": member, "field_schema": kind})


async def _stamp(client: httpx.AsyncClient, collection: _Collection) -> IndexStamp | None:
    """The stamp a collection states in its metadata. `None` for one that states none, or states one that is no object.

    Raises `CollectionAbsent` for a collection that is not there.
    """
    held = await client.get(collection.at())
    if held.status_code == _NOT_THERE:
        answered = f"it answered {held.status_code} to GET {collection.at()}"
        raise CollectionAbsent(f"Qdrant has no such collection ({answered}): no store has made it yet")
    metadata = _Described.model_validate(_result(held)).config.metadata
    stated = None if metadata is None else metadata.get("stamp")
    return stated if isinstance(stated, dict) else None


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


def _remembered(resource_id: ResourceId, declined: Declined) -> _Body:
    """The point that remembers a decline, as Qdrant is given one: kept under its resource's id, with the vector that says nothing."""
    payload: Payload = {
        "resourceId": str(resource_id),
        "contentChecksum": declined.content_checksum,
        "mediaType": declined.media_type,
        "reason": declined.reason,
    }
    return _point(str(resource_id), _NOTHING, payload)


def _declined_of(payload: Payload) -> tuple[ResourceId, Declined]:
    """The resource a point of the declined is of, and what it remembers of it.

    Raises `ValueError` for a payload that does not state all four members:
    it is no decline, and nothing is made up for what it leaves out.
    """
    resource_id = resource_of(payload)
    checksum, media_type, reason = payload.get("contentChecksum"), payload.get("mediaType"), payload.get("reason")
    if resource_id is None or not isinstance(checksum, str) or not isinstance(media_type, str) or not isinstance(reason, str):
        raise ValueError(f"a point of the declined does not state all that a decline is: {payload}")
    return resource_id, Declined(content_checksum=checksum, media_type=media_type, reason=reason)


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


def _point_of(annotation_id: AnnotationId) -> _Body:
    """The filter that holds of an annotation's one point, by the id it is kept under, and of no other."""
    ids: list[JsonValue] = [qdrant_id(annotation_key(annotation_id))]
    kept_under: JsonValue = {"has_id": ids}
    return {"must": [kept_under]}


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
    turns = asyncio.Semaphore(_ALIKE_AT_ONCE)

    async def nearest(vector: Sequence[float]) -> list[VectorSearchResult]:
        """The best point of each of the resources nearest one chunk, as many resources as the caller's limit."""
        # Grouped by resource, one point to a group: the limit counts resources, as the caller's does.
        body: _Body = {**_query(vector, options.limit, options, conditions), "group_by": "resourceId", "group_size": 1}
        async with turns:
            answered = _Grouped.model_validate(await _read(client, _RESOURCES.at("/points/query/groups"), body))
        return [result_of(hit.payload, hit.score) for group in answered.groups for hit in group.hits]

    found = await asyncio.gather(*(nearest(vector) for vector in vectors))
    return merge_by_resource([hit for hits in found for hit in hits])[: options.limit]


def _asking_for(members: Sequence[str], limit: int) -> _Body:
    """A scroll's body that asks for these members of each point's payload and no others, and for no vector."""
    wanted: list[JsonValue] = [*members]
    return {"limit": limit, "with_payload": wanted, "with_vector": False}


class _QdrantSearches(VectorReader):
    """What the reader and the store share: the way to the Qdrant at `host` and `port`, and a reader's reads asked over it."""

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

    @override
    async def get_resource_stamp(self, resource_id: ResourceId) -> ResourceStamp | None:
        asked: _Body = {**_asking_for(STAMP_MEMBERS, 1), "filter": _points_of(resource_id)}
        page = _Page.model_validate(await _read(self._reached(), _RESOURCES.at("/points/scroll"), asked))
        return stamp_of(_said(page.points[0])) if page.points else None


@final
class QdrantVectorReader(_QdrantSearches):
    """The index in the Qdrant at `host` and `port`, as a service that only searches it asks it.

    It makes nothing in the Qdrant: no collection, no index of a payload
    member, no point. Connecting asks the Qdrant which collections it has,
    which changes nothing, and raises where the Qdrant cannot be reached. A
    reader is told no width, and asks no embedding provider anything.

    A read of a collection that is not there raises `CollectionAbsent`. The
    service that writes the index makes its collections, and until it has,
    there is no index to ask. Qdrant answers a scroll or a query of such a
    collection with the status 404, and that status alone is read so: every
    other failure of a read is raised as it failed.
    """

    @override
    async def _ready(self, client: httpx.AsyncClient) -> None:
        _result(await client.get("/collections"))


@final
class QdrantVectorStore(_QdrantSearches, VectorStore):
    """The index in the Qdrant at `host` and `port`, as the service that writes it asks it. See the module's documentation.

    Connecting makes each collection that is not there, and asks for each
    index of a payload member. `dimensions` answers how wide the embedding
    provider's vectors are. It is asked only when a collection of those
    vectors must be made: where there is none at connecting, and whenever
    the index is made anew.
    """

    def __init__(self, *, host: str, port: int, dimensions: Callable[[], Awaitable[int]]) -> None:
        super().__init__(host=host, port=port)
        self._dimensions: Final = dimensions

    @override
    async def _ready(self, client: httpx.AsyncClient) -> None:
        for collection in _COLLECTIONS:
            await _made(client, collection, self._dimensions)
        # Asked for at every connection: a collection made before one of these members was indexed gets its index here.
        await _indexed(client)

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
        media_type: str,
    ) -> None:
        client = self._reached()
        # Every point the resource had goes first: a resource with fewer chunks than before would keep the rest.
        # What was remembered of a decline of it goes with them.
        await self.delete_resource_vectors(resource_id)
        if not chunks:
            return
        points: list[JsonValue] = []
        for chunk in chunks:
            payload = chunk_payload(resource_id, chunk, content_checksum, entity_types, machine_read=machine_read, media_type=media_type)
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
    async def update_annotation_entity_types(self, annotation_id: AnnotationId, entity_types: Sequence[str]) -> None:
        client = self._reached()
        types: list[JsonValue] = [*entity_types]
        # By a filter and not by naming the point's id: a filter that holds of no point sets nothing, and that is no failure.
        body: _Body = {"payload": {"entityTypes": types}, "filter": _point_of(annotation_id)}
        await _write(client, "POST", _ANNOTATIONS.at("/points/payload"), body)

    @override
    async def delete_resource_vectors(self, resource_id: ResourceId) -> None:
        client = self._reached()
        await _write(client, "POST", _RESOURCES.at("/points/delete"), {"filter": _points_of(resource_id)})
        # By its id: a point that is not there is taken as no failure.
        await _write(client, "POST", _DECLINED.at("/points/delete"), {"points": [qdrant_id(str(resource_id))]})

    @override
    async def delete_annotation_vector(self, annotation_id: AnnotationId) -> None:
        await _write(self._reached(), "POST", _ANNOTATIONS.at("/points/delete"), {"points": [qdrant_id(annotation_key(annotation_id))]})

    @override
    async def delete_annotation_vectors_for_resource(self, resource_id: ResourceId) -> None:
        await _write(self._reached(), "POST", _ANNOTATIONS.at("/points/delete"), {"filter": _points_of(resource_id)})

    @override
    async def decline_resource(self, resource_id: ResourceId, declined: Declined) -> None:
        client = self._reached()
        # The points go first: a store stopped between the two leaves a resource with neither, and never with both.
        await _write(client, "POST", _RESOURCES.at("/points/delete"), {"filter": _points_of(resource_id)})
        # One point for each resource, under its id: a decline put again replaces the one before.
        await _write(client, "PUT", _DECLINED.at("/points"), {"points": [_remembered(resource_id, declined)]})

    @override
    async def make_anew(self, stamp: IndexStamp) -> None:
        client = self._reached()
        # Asked before anything is taken: a provider that does not answer leaves the index as it was.
        width = await resolve_dimensions(self._dimensions)
        for collection in _COLLECTIONS:
            await _dropped(client, collection)
        for collection in _COLLECTIONS:
            if collection.size is None:
                await _make(client, collection, width, stamp)
            else:
                await _make(client, collection, collection.size, None)
        await _indexed(client)

    # ── What is indexed ────────────────────────────────────────────────

    @override
    async def count(self) -> int:
        client = self._reached()
        total = 0
        for collection in _EMBEDDED:
            counted = await _read(client, collection.at("/points/count"), {"exact": True})
            total += _Counted.model_validate(counted).count
        return total

    @override
    async def list_resource_stamps(self) -> dict[ResourceId, ResourceStamp]:
        stamps: dict[ResourceId, ResourceStamp] = {}
        async for page in _pages(self._reached(), _RESOURCES, _asking_for(STAMP_MEMBERS, _PAYLOAD_PAGE)):
            for point in page:
                payload = _said(point)
                resource_id = resource_of(payload)
                # Every point of a resource says the same of it: the first one read is its stamp.
                if resource_id is not None and resource_id not in stamps:
                    stamps[resource_id] = stamp_of(payload)
        return stamps

    @override
    async def list_annotation_stamps(self) -> dict[AnnotationId, AnnotationStamp]:
        stamps: dict[AnnotationId, AnnotationStamp] = {}
        async for page in _pages(self._reached(), _ANNOTATIONS, _asking_for(ANNOTATION_STAMP_MEMBERS, _PAYLOAD_PAGE)):
            for point in page:
                payload = _said(point)
                annotation_id = annotation_of(payload)
                if annotation_id is not None:
                    stamps[annotation_id] = annotation_stamp_of(payload)
        return stamps

    @override
    async def list_declined(self) -> dict[ResourceId, Declined]:
        declined: dict[ResourceId, Declined] = {}
        whole: _Body = {"limit": _PAYLOAD_PAGE, "with_payload": True, "with_vector": False}
        async for page in _pages(self._reached(), _DECLINED, whole):
            for point in page:
                resource_id, remembered = _declined_of(_said(point))
                declined[resource_id] = remembered
        return declined

    @override
    async def index_stamp(self) -> IndexStamp | None:
        client = self._reached()
        stated = [await _stamp(client, collection) for collection in _EMBEDDED]
        # Each was given the stamp when it was made anew. Where one states another, or none, the index says nothing.
        return stated[0] if all(each == stated[0] for each in stated) else None
