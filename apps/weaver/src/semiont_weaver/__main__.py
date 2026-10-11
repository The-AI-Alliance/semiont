"""`python -m semiont_weaver --config <path>`: the Weaver service, run as a process."""

import sys

from semiont_weaver.service import main

if __name__ == "__main__":
    sys.exit(main())
