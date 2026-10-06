"""The wire driver: this SDK's transport, as `tests/conformance/sdk/wire` drives it.

It performs no operation: the SDK has no transport. Each wire case is named in
this SDK's line of `SDK_DRIVERS` with why, and the suite holds each by
requiring this driver to answer `unsupported` to what the case asks.
"""

import sys

from protocol import serve

if __name__ == "__main__":
    sys.exit(serve())
