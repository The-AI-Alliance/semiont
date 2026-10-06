"""What every namespace reaches the knowledge base through."""

import asyncio
from collections.abc import Coroutine
from typing import Final, final

from semiont.bus import Bus
from semiont.channel import Channel, Operation
from semiont.errors import SemiontError
from semiont.event_bus import EventBus
from semiont.model import WireModel

__all__ = ["Links"]


@final
class Links:
    """The bus over the wire, the client's own bus, the waits the client keeps, and the tasks it runs."""

    def __init__(self, *, wire: Bus, own: EventBus, bus_request_ms: int, job_silence_ms: int, job_status_poll_ms: int) -> None:
        self.wire: Final = wire
        self.own: Final = own
        self.bus_request_ms: Final = bus_request_ms
        self.job_silence_ms: Final = job_silence_ms
        self.job_status_poll_ms: Final = job_status_poll_ms
        self._tasks: Final[set[asyncio.Task[object]]] = set()

    async def request[Q: WireModel, R: WireModel, F: WireModel](self, operation: Operation[Q, R, F], payload: Q) -> R:
        """A request of `operation`, within the client's deadline."""
        return await self.wire.request(operation, payload, timeout_ms=self.bus_request_ms)

    async def drive[P: WireModel](self, channel: Channel[P], payload: P) -> int | None:
        """A drive at the other participants: one frame over the wire, and how many of them the gateway reached."""
        return await self.wire.emit(channel, payload)

    def signal[P: WireModel](self, channel: Channel[P], payload: P, *, correlation_id: str | None = None) -> None:
        """A signal to this client's own parts. It never reaches the wire."""
        self.own.publish(channel, payload, correlation_id=correlation_id)

    def report[P: WireModel](self, channel: Channel[P], payload: P) -> None:
        """A report over the wire that nobody awaits.

        The transport tells its failures of an emit it could not send, which
        is where a failure of this one is heard.
        """
        self.run(self._reported(channel, payload))

    async def _reported[P: WireModel](self, channel: Channel[P], payload: P) -> None:
        try:
            await self.wire.emit(channel, payload)
        except SemiontError:
            return

    def run[T](self, work: Coroutine[object, object, T]) -> asyncio.Task[T]:
        """Run `work` as a task of the client's: one that has ended by the time the client has closed."""
        task = asyncio.ensure_future(work)
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return task

    async def close(self) -> None:
        """End every task `run` began that has not ended by itself."""
        tasks = list(self._tasks)
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
