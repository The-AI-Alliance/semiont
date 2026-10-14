"""What a state unit has running: its listener, and each operation it started."""

import asyncio
from collections.abc import Coroutine
from typing import Final, final

__all__ = ["Tasks"]


@final
class Tasks:
    """A unit's tasks. Stopped when the unit is disposed, after which nothing more is started."""

    def __init__(self) -> None:
        self._running: Final[set[asyncio.Task[None]]] = set()
        self._stopped = False

    def run(self, work: Coroutine[object, object, None]) -> None:
        """Run `work` as one of the unit's tasks. Once stopped, it is not started."""
        if self._stopped:
            # Never awaited, so it is closed here and is not reported as forgotten.
            work.close()
            return
        task = asyncio.ensure_future(work)
        self._running.add(task)
        task.add_done_callback(self._running.discard)

    def stop(self) -> None:
        """Cancel everything running, and start nothing more. Stopping twice is stopping once."""
        self._stopped = True
        for task in list(self._running):
            task.cancel()

    async def ended(self) -> None:
        """Return once every task has ended, each that was cancelled among them."""
        await asyncio.gather(*self._running, return_exceptions=True)
