"""The Ollama provider: an embedding model served by Ollama, asked over Ollama's own HTTP API.

One call is made of it: `POST {base_url}/api/embed`, with the model's name
and a list of texts (`input`). The call has no member that says what a text
is for, so a query and a document are sent alike. Ollama answers an object
whose `embeddings` is a vector for each text, in the order of the texts. A
model it does not have is a 404, which is also what it answers while the
model is still being fetched.
"""

from collections.abc import Sequence
from typing import Final, final

import httpx
from pydantic import BaseModel, ValidationError

from semiont_vectors._dimensions import Width
from semiont_vectors._slices import CONNECT_SECONDS, Batches
from semiont_vectors.embedding import BatchPolicy, EmbeddingProviderError, TextKind

__all__ = ["OLLAMA_BATCH_POLICY", "OllamaEmbeddingProvider"]

OLLAMA_BATCH_POLICY: Final = BatchPolicy(slice_size=128, concurrency=1)
"""How an Ollama is asked for many texts. Ollama states no most for a request and no rate, so both numbers are this package's.

128 texts in a request: about 1,100 chunks have been embedded in about 15
seconds by a `nomic-embed-text` on the machine that asked, so a request of
128 takes under two seconds of the 15 a request has. A model much slower
than that needs a smaller number.

One request at a time: one process serves the one model, so requests made at
once wait on each other there, and crowd its memory. Several Ollamas behind
one address would bear more.
"""

# The time of a whole request is kept where the request takes its turn, and none of the client's own clocks is
# used for it: each of them starts again with every read. Making the connection alone has a bound here.
_TIMEOUT: Final = httpx.Timeout(None, connect=CONNECT_SECONDS)


class _Answer(BaseModel, frozen=True):
    """What `/api/embed` answers, of which the vectors alone are read."""

    embeddings: list[list[float]]


def _vectors(answer: bytes, texts: int) -> list[list[float]]:
    """The vectors an answer holds: one for each of `texts` texts, in their order.

    Raises `ValueError`, which says what is wrong, for an answer that does not hold them.
    """
    try:
        vectors = _Answer.model_validate_json(answer, strict=True).embeddings
    except ValidationError as unread:
        raise ValueError("the answer is not an object whose `embeddings` is a list of vectors") from unread
    if len(vectors) != texts:
        raise ValueError(f"the answer's vectors number {len(vectors)}, and the texts sent {texts}")
    if not all(vectors):
        raise ValueError("the answer holds a vector of no numbers")
    return vectors


@final
class OllamaEmbeddingProvider:
    """The embedding model `model`, served by the Ollama at `base_url`."""

    def __init__(self, *, model: str, base_url: str) -> None:
        self._model: Final = model
        self._url: Final = f"{base_url.rstrip('/')}/api/embed"
        self._batches: Final = Batches(provider="ollama", model=model, policy=OLLAMA_BATCH_POLICY, post=self._post)
        self._width: Final = Width(self.embed_query)

    async def embed_query(self, text: str) -> list[float]:
        # One text is a batch of one: there is one way a request is made, and it waits its turn like any other.
        (vector,) = await self._batches.embed([text], "query")
        return vector

    async def embed_documents(self, texts: Sequence[str]) -> list[list[float]]:
        return await self._batches.embed(texts, "document")

    async def dimensions(self) -> int:
        return await self._width.get()

    async def _post(self, texts: Sequence[str], kind: TextKind) -> list[list[float]]:
        # Nothing of `kind` is sent: Ollama's call has no member that says what a text is for.
        try:
            # The address a caller names is the address asked: no proxy of the environment stands between.
            async with httpx.AsyncClient(timeout=_TIMEOUT, trust_env=False) as http:
                response = await http.post(self._url, json={"model": self._model, "input": [*texts]})
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
        return EmbeddingProviderError(provider="ollama", status=status, reached=reached, model=self._model, body=body)
