"""`python -m semiont_worker --config <path>`: the Worker service, run as a process."""

import sys

from semiont_worker.service import main

if __name__ == "__main__":
    sys.exit(main())
