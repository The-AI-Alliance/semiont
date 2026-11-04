"""How long a service asks the Archivist over the bus while nothing answers there yet.

A service that signs in before the Archivist has subscribed asks a channel
nobody answers yet, and the gateway says so (`bus.peer-unavailable`). The
Archivist's own start can take minutes, so such a request is asked again, and
any other failure is not.
"""

from typing import Final

from semiont.errors import BusRequestError, SemiontError
from semiont.retry import RetryPolicy

__all__ = ["UNTIL_THE_ARCHIVIST_ANSWERS", "nobody_answers"]

UNTIL_THE_ARCHIVIST_ANSWERS: Final = RetryPolicy(attempts=17, initial_delay_ms=1_000, max_delay_ms=30_000)
"""How long a request is asked again while the Archivist is not there to answer: about five and a half minutes in all."""


def nobody_answers(failure: SemiontError) -> bool:
    """Whether `failure` is a request nobody answered yet: the one failure asked again."""
    return isinstance(failure, BusRequestError) and failure.code == "bus.peer-unavailable"
