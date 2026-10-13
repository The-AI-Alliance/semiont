"""Connecting to what a service cannot start without, and how long it waits for an answer.

A service that starts connects to what it reads or writes for as long as it
runs: its graph database, its vector index. Each is given one minute to
answer, the same minute in every service. What has not answered by then ends
the start: the service says what did not answer and exits, to be started
again by whatever supervises it.
"""

import asyncio
from collections.abc import Awaitable
from typing import Final

from semiont_service.config import Refused

__all__ = ["connected"]

_CONNECT_SECONDS: Final = 60.0
"""How long what a service connects to is given to answer when the service starts. Past it the service exits, to be started again."""


async def connected[T](what: str, connecting: Awaitable[T]) -> T:
    """What `connecting` answers, waited for as long as a start waits and no longer.

    `what` is what is being connected to, as the refusal names it after
    `The`: `graph database`. Raises `Refused`, naming it, where it has not
    answered in time, and what was waiting on it is cancelled.
    """
    try:
        async with asyncio.timeout(_CONNECT_SECONDS):
            return await connecting
    except TimeoutError:
        raise Refused(f"The {what} did not answer within {_CONNECT_SECONDS:.0f} seconds") from None
