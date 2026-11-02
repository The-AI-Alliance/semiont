# Generated from specs/src/sign-in-store/owner-only.json; do not edit.
# Regenerate: node scripts/spec/generate-sign-in-python.mjs

"""How a writer of the sign-in store keeps its directory and its files to their owner, as the launcher keeps its state home."""

from typing import Final

__all__ = ["DIRECTORY_MODE", "FILE_MODE", "access_list"]

# The directory's mode, in octal, on a system that has modes: its owner reads, writes and enters
# it, and nobody else does.
DIRECTORY_MODE: Final = 0o700

# The mode, in octal, on a system that has modes, that a writer makes tokens.json's temporary
# file and its lock with, and the launcher its own files in its state home: its owner reads and
# writes each, and nobody else does.
FILE_MODE: Final = 0o600


def access_list(owner: str) -> str:
    """The directory's access list on Windows, where a mode keeps nobody out, in SDDL, with `owner`
    where the SID of the user the writer runs as goes (its process token's user): full access
    for that user, the system and the administrators, and nobody else. It is handed down to
    everything made in the directory, and protected, so nothing is inherited from above.
    """
    return "D:PAI(A;OICI;FA;;;" + owner + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
