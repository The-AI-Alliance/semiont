"""The service's one logger.

Everything the service's own code logs goes through it: a short message with
its facts beside it (`extra`), each under a name in camel case. How the
process's log is written, and how much of it, is `semiont_service.log`'s.
"""

import logging
from typing import Final

__all__ = ["LOG"]

LOG: Final = logging.getLogger("semiont_librarian")
