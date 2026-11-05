"""Which knowledge base a service serves: the one its document names, once the knowledge base has said it is that one.

A service is told its knowledge base by its document, and signing in at that
knowledge base's issuer proves it may act there. Before it touches anything
it keeps for the knowledge base, it asks the knowledge base which it is
(`browse:kb-requested`, which the Archivist answers from the committed
`.semiont/config.yaml`), on a stream that names the answer's replies and
nothing the service answers, and refuses to start where the answer is
another domain than its document's. A document naming one
knowledge base beside a gateway that serves another would have the service
keep the second's data under the first's name.

Two refusals are told apart. One the knowledge base answered, another domain
or a failure, is its verdict, and asking again gets it again. One where it
never said (`Unanswered`) is that nothing answered in time: a service of one
knowledge base refuses to start all the same, and one of several may ask
that knowledge base again later.
"""

import asyncio
from typing import Final, final

from semiont.bus import Bus, reply_channels_for
from semiont.errors import BusRequestError, SemiontError
from semiont.identity import kb_did
from semiont.operations import BROWSE_KB_REQUESTED
from semiont.retry import retry_with_backoff
from semiont.types import BrowseKbRequest, BrowseKbResult

from semiont_service.config import Refused
from semiont_service.until_answered import UNTIL_THE_ARCHIVIST_ANSWERS, nobody_answers

__all__ = ["CONFIRMING_CHANNELS", "Unanswered", "confirmed"]

CONFIRMING_CHANNELS: Final = reply_channels_for(BROWSE_KB_REQUESTED)
"""What the stream a service confirms its knowledge base on names: the answer's replies, and nothing the service answers.

A request reaches every stream that names its channel, and is answered at
once that nothing answers only where it reaches none. A service whose own
stream named what it answers before it could answer would take what is sent
meanwhile, and leave whoever sent it to wait out its deadline.
"""


@final
class Unanswered(Refused):
    """The knowledge base did not say which it is: no answer in time, or none however long it was asked again."""


async def confirmed(bus: Bus, domain: str, stopping: asyncio.Event) -> bool:
    """Whether the knowledge base at the other end of `bus` said it is the one of `domain` before `stopping` was set.

    It is asked again while the Archivist is not there to answer
    (`semiont_service.until_answered`), and not once `stopping` is set.
    Raises `Refused` where it answers as another knowledge base, or with a
    failure, and `Unanswered` where it does not answer.
    """

    async def asked() -> BrowseKbResult:
        return await bus.request(BROWSE_KB_REQUESTED, BrowseKbRequest())

    try:
        answered = (await retry_with_backoff(UNTIL_THE_ARCHIVIST_ANSWERS, asked, retryable=nobody_answers, give_up=stopping)).response
    except SemiontError as unsaid:
        if stopping.is_set():
            return False
        if isinstance(unsaid, BusRequestError) and unsaid.failure is not None and not nobody_answers(unsaid):
            raise Refused(f"The knowledge base answered which it is with a failure (browse:kb-failed): {unsaid}") from unsaid
        raise Unanswered(f"The knowledge base did not answer which it is (browse:kb-requested): {unsaid}") from unsaid
    if answered.domain != domain:
        raise Refused(f"The knowledge base at the gateway is {kb_did(answered.domain)}, and the document names {kb_did(domain)}")
    return True
