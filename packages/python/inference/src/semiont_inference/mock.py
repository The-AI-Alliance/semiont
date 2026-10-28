"""A client that asks no provider: it answers from a list it is given, and keeps the calls made of it. For tests."""

import asyncio
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Final, final

from semiont_inference._structured import read_array
from semiont_inference.interface import ElementSchema, InferenceLimits, InferenceResponse, StructuredResponse

__all__ = ["MockInferenceClient"]


@final
@dataclass(frozen=True, slots=True)
class _Call:
    """One call, as it was made. `element_schema` is None for a call that asked for plain text."""

    prompt: str
    max_tokens: int
    temperature: float
    element_schema: ElementSchema | None


def _paired(responses: Sequence[str], stop_reasons: Sequence[str]) -> list[tuple[str, str]]:
    """Each response with why the model is to have stopped there."""
    if len(responses) != len(stop_reasons):
        raise ValueError(f"{len(responses)} responses and {len(stop_reasons)} stop reasons: each response has one")
    if not responses:
        raise ValueError("a mock answers from at least one response")
    return list(zip(responses, stop_reasons, strict=True))


@final
class MockInferenceClient:
    """Answers each call with the next of `responses`, and with the last of them once they are used up.

    Each response has its stop reason, in `stop_reasons`. `limits` is what
    `limits()` answers. `calls` is every call made, in order.

    A structured call reads its response as a driver reads a provider's
    reply: a response that is not a JSON array raises `StructuredReadError`,
    so a test asks for that failure by giving such a response.
    """

    def __init__(self, responses: Sequence[str], *, stop_reasons: Sequence[str], limits: InferenceLimits) -> None:
        self.provider: Final = "mock"
        self.model_id: Final = "mock-model"
        # One at a time: a test's responses are then taken in the order its calls are made.
        self.max_concurrency: Final = 1
        # A count call would take a response off the list. A test of the verifier is a test of another client.
        self.verify_detection_yield: Final = False
        self.calls: list[_Call] = []
        self._limits = limits
        self._replies = _paired(responses, stop_reasons)
        self._next = 0

    async def limits(self) -> InferenceLimits:
        return self._limits

    async def generate_text(self, prompt: str, max_tokens: int, temperature: float) -> InferenceResponse:
        text, stop_reason = await self._answer(_Call(prompt, max_tokens, temperature, None))
        return InferenceResponse(text=text, stop_reason=stop_reason, usage=None)

    async def generate_structured(
        self, prompt: str, max_tokens: int, temperature: float, element_schema: ElementSchema
    ) -> StructuredResponse:
        text, stop_reason = await self._answer(_Call(prompt, max_tokens, temperature, element_schema))
        return StructuredResponse(items=read_array(text, stop_reason), stop_reason=stop_reason, usage=None)

    def reset(self) -> None:
        """Forget the calls made, and answer from the first response again."""
        self.calls = []
        self._next = 0

    def set_responses(self, responses: Sequence[str], *, stop_reasons: Sequence[str]) -> None:
        """Answer from `responses` from now on, beginning with the first. The calls already made are kept."""
        self._replies = _paired(responses, stop_reasons)
        self._next = 0

    async def _answer(self, call: _Call) -> tuple[str, str]:
        # A real driver waits on its provider, so a cancellation asked of its caller lands inside the
        # call. This has nothing to wait on, and gives the loop one turn so that the same is true of it.
        await asyncio.sleep(0)
        self.calls.append(call)
        reply = self._replies[self._next]
        if self._next < len(self._replies) - 1:
            self._next += 1
        return reply
