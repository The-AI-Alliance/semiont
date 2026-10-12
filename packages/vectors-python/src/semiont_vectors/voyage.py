"""The Voyage provider: an embedding model served by Voyage AI, asked over Voyage's HTTP API.

This driver has not met the real service. It is written from Voyage's API
reference (https://docs.voyageai.com/reference/embeddings-api) and is held
by tests that play Voyage from that reference. No request has been made of
Voyage itself, by a test or by hand.

One call is made of it: `POST {endpoint}`, with the key as a bearer token,
the model's name and a list of texts (`input`). Nothing else the reference
allows in a request is sent, so each is as Voyage has it when left out:
`input_type` (a text is embedded as it is, as neither a query nor a
document), `truncation` (a text longer than the model reads is cut short,
and nothing says so), `output_dimension` and `output_dtype` (vectors of the
model's own width, of floats) and `encoding_format`.

Voyage answers an object whose `data` is a list of items, each a vector
(`embedding`) and which of the texts sent it is of (`index`). The reference
does not say the items are in the order of the texts. So each vector is put
at its `index`, and the order of the list is not relied on.
"""

from collections.abc import Sequence
from typing import Final, final

import httpx
from pydantic import BaseModel, ValidationError

from semiont_vectors._dimensions import Width
from semiont_vectors._slices import CONNECT_SECONDS, Batches
from semiont_vectors.embedding import BatchPolicy, EmbeddingProviderError

__all__ = ["VOYAGE_BATCH_POLICY", "VoyageEmbeddingProvider"]

VOYAGE_BATCH_POLICY: Final = BatchPolicy(slice_size=128, concurrency=4)
"""How Voyage is asked for many texts. Both numbers rest on what Voyage's reference states, and on no request ever made of Voyage.

128 texts in a request: a request may carry 1,000, and 128 is the size
Voyage's own account of batching uses. A request's tokens are bounded as
well, at 120,000 for the models with the least room, and nothing here counts
tokens: 128 texts stay within that while they average no more than 937
tokens each.

Four requests at once: an answer is waited for over a network, so requests
made together are answered sooner than one after another. The basic tier
allows 2,000 requests a minute, which four at once stay within unless each
is answered in less than 0.12 seconds. The tokens a tier allows in a minute
are not kept to by either number: Voyage answers 429 to a request over
them, and that request's batch fails.
"""

# The time of a whole request is kept where the request takes its turn, and none of the client's own clocks is
# used for it: each of them starts again with every read. Making the connection alone has a bound here.
_TIMEOUT: Final = httpx.Timeout(None, connect=CONNECT_SECONDS)


class _Embedded(BaseModel, frozen=True):
    """One item of an answer's `data`: a vector, and which of the texts sent it is of, counted from 0."""

    index: int
    embedding: list[float]


class _Answer(BaseModel, frozen=True):
    """What the embeddings call answers, of which the vectors and their places alone are read."""

    data: list[_Embedded]


def _vectors(answer: bytes, texts: int) -> list[list[float]]:
    """The vectors an answer holds: one for each of `texts` texts, in the order of the texts and not of the answer's items.

    Raises `ValueError`, which says what is wrong, for an answer that does not hold them.
    """
    try:
        items = _Answer.model_validate_json(answer, strict=True).data
    except ValidationError as unread:
        raise ValueError("the answer is not an object whose `data` is a list of items, each an `index` and an `embedding`") from unread
    placed = {item.index: item.embedding for item in items}
    if len(items) != texts or sorted(placed) != list(range(texts)):
        raise ValueError(f"the answer's {len(items)} items are not one for each of the {texts} texts sent")
    if not all(placed.values()):
        raise ValueError("the answer holds a vector of no numbers")
    return [placed[index] for index in range(texts)]


@final
class VoyageEmbeddingProvider:
    """The embedding model `model`, asked of Voyage with `api_key`. `endpoint` is the whole address of Voyage's embeddings call."""

    def __init__(self, *, model: str, api_key: str, endpoint: str) -> None:
        self._model: Final = model
        self._endpoint: Final = endpoint
        self._headers: Final = {"Authorization": f"Bearer {api_key}"}
        self._batches: Final = Batches(provider="voyage", model=model, policy=VOYAGE_BATCH_POLICY, post=self._post)
        self._width: Final = Width(self.embed)

    async def embed(self, text: str) -> list[float]:
        # One text is a batch of one: there is one way a request is made, and it waits its turn like any other.
        (vector,) = await self.embed_batch([text])
        return vector

    async def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._batches.embed(texts)

    async def dimensions(self) -> int:
        return await self._width.get()

    async def _post(self, texts: Sequence[str]) -> list[list[float]]:
        try:
            # The address a caller names is the address asked: no proxy of the environment stands between.
            async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as http:
                response = await http.post(self._endpoint, headers=self._headers, json={"model": self._model, "input": [*texts]})
        except (httpx.ConnectError, httpx.ConnectTimeout) as unreached:
            raise self._failed(None, f"{type(unreached).__name__}: {unreached}", reached=False) from unreached
        except httpx.TransportError as broken:
            raise self._failed(None, f"{type(broken).__name__}: {broken}", reached=True) from broken
        if not response.is_success:
            raise self._failed(response.status_code, response.text, reached=True)
        try:
            return _vectors(response.content, len(texts))
        except ValueError as unread:
            raise self._failed(response.status_code, str(unread), reached=True) from unread

    def _failed(self, status: int | None, body: str, *, reached: bool) -> EmbeddingProviderError:
        return EmbeddingProviderError(provider="voyage", status=status, reached=reached, model=self._model, body=body)
