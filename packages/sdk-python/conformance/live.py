"""The live driver: this SDK's client, as `tests/conformance/sdk/live` drives it.

It performs no operation: the SDK has no client. It is not in this SDK's line
of `SDK_DRIVERS`, so no live case is run against it.
"""

import sys

from protocol import serve

if __name__ == "__main__":
    sys.exit(serve())
