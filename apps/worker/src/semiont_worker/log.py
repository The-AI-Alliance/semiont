"""The service's one logger.

Every event is a short message with its facts beside it (`extra`), each under
a name in camel case. The service formats both as its configuration says.
"""

import logging
from typing import Final

LOG: Final = logging.getLogger("semiont_worker")
