# Generated from specs/src/sign-in-store/owner-only.json; do not edit.
# Regenerate: node scripts/spec/generate-sign-in-python.mjs

"""How a writer of the sign-in store keeps its directory to its owner, as the launcher keeps its state home."""

from typing import Final

__all__ = ["MODE", "access_list"]

# The directory's mode, in octal, on a system that has modes: its owner reads, writes and enters
# it, and nobody else does.
MODE: Final = 0o700


def access_list(owner: str) -> str:
    """The directory's access list on Windows, where a mode keeps nobody out, in SDDL, with `owner`
    where the SID of the user the writer runs as goes (its process token's user): full access
    for that user, the system and the administrators, and nobody else. It is handed down to
    everything made in the directory, and protected, so nothing is inherited from above.
    """
    return "D:PAI(A;OICI;FA;;;" + owner + ")(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"
