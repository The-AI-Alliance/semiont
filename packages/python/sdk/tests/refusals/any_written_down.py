"""`Any` turns checking off, so it is not written."""

from typing import Any


# mypy refuses it. pyright has no rule that does.
def takes(anything: Any) -> None: ...  # type: ignore[explicit-any]
