"""What is printed of a failure, and what of a credential that holds."""

import traceback

from tokens import jwt

CARRIED = jwt({"iat": 1_800_000_000, "exp": 1_800_003_600, "n": 7})
"""A token in an exchange that signs nobody in. It is a credential all the same."""


def printed(failure: BaseException) -> str:
    """What is printed of a failure wherever it is logged: its own line, and the line of each failure it is shown to have come from."""
    lines = [repr(failure)]
    shown: traceback.TracebackException | None = traceback.TracebackException.from_exception(failure)
    while shown is not None:
        lines.extend(shown.format_exception_only())
        came_during = None if shown.__suppress_context__ else shown.__context__
        shown = came_during if shown.__cause__ is None else shown.__cause__
    return "\n".join(lines)


def parts_of(secret: str, shown: str) -> list[str]:
    """The runs of six characters of `secret` that `shown` holds: a fragment of a credential is one too."""
    return [secret[at : at + 6] for at in range(len(secret) - 5) if secret[at : at + 6] in shown]
