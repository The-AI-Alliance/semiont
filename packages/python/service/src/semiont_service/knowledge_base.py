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
"""

import asyncio
from typing import Final

from semiont.bus import Bus
from semiont.errors import SemiontError
from semiont.identity import kb_did
from semiont.operations import BROWSE_KB_REQUESTED
from semiont.retry import retry_with_backoff
from semiont.types import BrowseKbRequest, BrowseKbResult, KbIdentity

from semiont_service.config import Refused
from semiont_service.until_answered import UNTIL_THE_ARCHIVIST_ANSWERS, nobody_answers

__all__ = ["CONFIRMING", "confirmed"]

CONFIRMING: Final = (BROWSE_KB_REQUESTED,)
"""What the confirmation asks: the stream of a service that confirms its knowledge base names its replies."""


async def confirmed(bus: Bus, kb: KbIdentity, stopping: asyncio.Event) -> bool:
    """Whether the knowledge base at the other end of `bus` said it is `kb` before `stopping` was set.

    It is asked again while the Archivist is not there to answer
    (`semiont_service.until_answered`), and not once `stopping` is set.
    Raises `Refused` where it answers as another knowledge base, and where it
    does not say which it is.
    """

    async def asked() -> BrowseKbResult:
        return await bus.request(BROWSE_KB_REQUESTED, BrowseKbRequest())

    try:
        answered = (await retry_with_backoff(UNTIL_THE_ARCHIVIST_ANSWERS, asked, retryable=nobody_answers, give_up=stopping)).response
    except SemiontError as unsaid:
        if stopping.is_set():
            return False
        raise Refused(f"The knowledge base did not say which it is (browse:kb-requested): {unsaid}") from unsaid
    if answered.domain != kb.domain:
        raise Refused(f"The knowledge base at the gateway is {kb_did(answered.domain)}, and the document names {kb_did(kb.domain)}")
    return True
