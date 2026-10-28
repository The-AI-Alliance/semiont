"""`python -m semiont_librarian --config <path>`: the Librarian service, run as a process."""

import sys

from semiont_librarian.service import main

if __name__ == "__main__":
    sys.exit(main())
