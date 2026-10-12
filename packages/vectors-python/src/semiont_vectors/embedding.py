"""What an embedding provider is asked and answers, and the failure one raises.

A provider makes a vector of a text. Which model it asks, and where, is given
to it when it is made. A vector is as wide as the model makes it: the width
is asked of the provider, which measures it, and is written down nowhere.

No type of an HTTP client appears here.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, Literal, Protocol, final

__all__ = [
    "EMBED_ROUND_TRIP_SECONDS",
    "BatchPolicy",
    "EmbeddingProvider",
    "EmbeddingProviderError",
    "ProviderName",
    "SliceRef",
]

type ProviderName = Literal["ollama", "voyage"]
"""Who serves the model."""

EMBED_ROUND_TRIP_SECONDS: Final = 15.0
"""How long one request to a provider may take, from when it is sent: one request, never a whole batch.

An Ollama may spend seconds of it loading a model into memory on the first
request after the model arrives, which is a success on its way.
"""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class BatchPolicy:
    """How a provider is asked for many texts. The numbers are each provider's own, and it states where they come from."""

    slice_size: int
    """The most texts in one request."""
    concurrency: int
    """The most requests to this provider at once, from one process."""


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class SliceRef:
    """Which of a batch's texts one request carried."""

    index: int
    """Which request of the batch it was, counted from 0."""
    start: int
    """The first of its texts, counted from 0 in the batch."""
    end: int
    """One past the last of its texts."""


@final
class EmbeddingProviderError(Exception):
    """A request to an embedding provider that did not give vectors.

    What is known of the failure is on its fields, and nothing that handles
    one reads it out of the message. `status` is the status the provider
    answered with, and `None` where no answer came. `reached` is `False`
    where no connection to the provider could be made at all, which is how a
    provider that is still starting looks; a request that was sent and ran
    out of time, or broke off, reached it. `model` is the model asked for.
    `body` is what the provider answered, or, with no answer, what went
    wrong. `slice` says which request of a batch it was, when it was one of
    a batch.
    """

    def __init__(
        self, *, provider: ProviderName, status: int | None, reached: bool, model: str, body: str, slice: SliceRef | None = None
    ) -> None:
        where = "" if slice is None else f" (slice {slice.index}, texts {slice.start} to {slice.end})"
        answered = "no response" if status is None else str(status)
        super().__init__(f"{provider} embed error {answered}{where}: {body}")
        self.provider: Final = provider
        self.status: Final = status
        self.reached: Final = reached
        self.model: Final = model
        self.body: Final = body
        self.slice: Final = slice


class EmbeddingProvider(Protocol):
    """An embedding provider, as a service asks it. Every provider has these members and no others."""

    async def embed(self, text: str) -> list[float]:
        """The vector of one text. Raises `EmbeddingProviderError` where the provider gives none."""
        ...

    async def embed_batch(self, texts: Sequence[str]) -> list[list[float]]:
        """The vector of each text, in the order of the texts.

        The texts are asked for in as many requests as the provider's policy
        makes of them. One request that fails fails them all: raises
        `EmbeddingProviderError`, which says which request it was.
        """
        ...

    async def dimensions(self) -> int:
        """How wide this provider's vectors are, measured by asking it for one.

        Measured once for each provider made. A measurement that failed is
        not kept: the next call measures again.
        """
        ...
