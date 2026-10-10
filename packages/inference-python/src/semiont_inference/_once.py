"""What a driver learns once for every caller: its model's limits."""

import asyncio
from collections.abc import Callable, Coroutine
from typing import final


@final
class Once[T]:
    """One thing learned by asking, at the first call, and kept.

    Callers that ask while it is being learned share the one asking. A
    failure is not kept: the next call asks again, so an outage that passes
    does not go on failing every later call.

    The asking is no caller's own. A caller cancelled while it waits leaves
    at once, with its cancellation as it is, and the asking goes on for the
    others and for the next call.
    """

    def __init__(self, learn: Callable[[], Coroutine[None, None, T]]) -> None:
        self._learn = learn
        self._learned: tuple[T] | None = None
        self._learning: asyncio.Task[T] | None = None

    async def get(self) -> T:
        if self._learned is not None:
            return self._learned[0]
        if self._learning is None:
            self._learning = asyncio.get_running_loop().create_task(self._learn())
            self._learning.add_done_callback(self._settled)
        # The shield is around the asking, which every caller shares. It is not around this
        # caller's wait, which ends when the caller is cancelled.
        return await asyncio.shield(self._learning)

    def _settled(self, learning: asyncio.Task[T]) -> None:
        self._learning = None
        # Reading the failure is also what tells the loop it was seen: a caller that left is not there to see it.
        if not learning.cancelled() and learning.exception() is None:
            self._learned = (learning.result(),)
