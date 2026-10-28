"""The service's one logger, and how a failure is said in it.

Everything the service's own code logs goes through it: a short message with
its facts beside it (`extra`), each under a name in camel case. How the
process's log is written, and how much of it, is `semiont_service.log`'s.
"""

import logging
from typing import Final

from semiont_vectors.embedding import EmbeddingProviderError

__all__ = ["LOG", "failure_said", "words_of"]

LOG: Final = logging.getLogger("semiont_smelter")


def words_of(failure: BaseException) -> str:
    """A failure, in a line: what kind it is, and what it says."""
    return f"{type(failure).__name__}: {failure}"


def failure_said(failure: BaseException) -> dict[str, object]:
    """A failure as the facts of a log line: `error`, its words, and what is known of it beside them.

    An embedding provider's failure says which provider was asked, for which
    model, what status it answered with, and which request of a batch it
    was. Its words state the status and the request, and not the model: each
    is a fact of its own here, so that none is read out of a message.
    """
    said: dict[str, object] = {"error": words_of(failure)}
    if isinstance(failure, EmbeddingProviderError):
        said["provider"], said["model"], said["status"] = failure.provider, failure.model, failure.status
        if failure.slice is not None:
            said["slice"] = {"index": failure.slice.index, "start": failure.slice.start, "end": failure.slice.end}
    return said
