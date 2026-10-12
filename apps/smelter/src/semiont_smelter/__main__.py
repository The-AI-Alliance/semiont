"""`python -m semiont_smelter --config <path>`: the Smelter service, run as a process."""

import sys

from semiont_smelter.service import main

if __name__ == "__main__":
    sys.exit(main())
