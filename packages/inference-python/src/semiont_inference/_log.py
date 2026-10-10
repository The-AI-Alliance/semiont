"""The package's one logger.

Every event is a short message with its facts beside it (`extra`), under the
names the TypeScript drivers log them by: a service formats both as its own
config says.
"""

import logging
from typing import Final

LOG: Final = logging.getLogger("semiont_inference")
