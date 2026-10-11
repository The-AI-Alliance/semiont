"""How far a Weaver has got: for each resource, the sequence number it has applied up to.

`docs/protocol/WEAVER.md` § What it has applied. A mark says that everything
at or below it was applied. So it only rises, and it never reaches an event
that was not applied, however many later events of the resource are. What
was missed is then found again when the Weaver next starts: catch-up applies
what is above the mark.
"""

from collections.abc import Mapping
from typing import Final, final

__all__ = ["Marks"]


@final
class Marks:
    """The marks, and the events that hold them back."""

    def __init__(self) -> None:
        self._applied: Final[dict[str, int]] = {}
        self._not_applied: Final[dict[str, set[int]]] = {}
        """For each resource, the sequences of its events that were not applied and have not been since."""
        self.failures = 0
        """How many events were not applied, since the Weaver started."""
        self.unsaved = False
        """Whether a mark has risen since the marks were last kept."""

    def of(self, resource: str) -> int:
        """The sequence a resource is applied up to. 0 for one of which nothing is: a record's sequences begin at 1."""
        return self._applied.get(resource, 0)

    def all(self) -> dict[str, int]:
        return dict(self._applied)

    def tracked(self) -> int:
        return len(self._applied)

    def keep(self, kept: Mapping[str, int]) -> None:
        """Take up marks kept from an earlier life of the Weaver: each raises the resource's mark, and lowers none."""
        for resource, sequence in kept.items():
            if sequence > self.of(resource):
                self._applied[resource] = sequence

    def forget(self, resource: str) -> None:
        """Drop a resource's mark: what it claimed is not so."""
        self._applied.pop(resource, None)

    def landed(self, resource: str, sequence: int) -> None:
        """An event was applied. If it had not been before, it holds the mark back no longer."""
        held_back = self._not_applied.get(resource)
        if held_back is not None:
            held_back.discard(sequence)
            if not held_back:
                del self._not_applied[resource]

    def missed(self, resource: str | None, sequence: int) -> None:
        """An event was not applied: it is counted, and holds its resource's mark below it until it is."""
        self.failures += 1
        if resource is not None:
            self._not_applied.setdefault(resource, set()).add(sequence)

    def reach(self, resource: str, sequence: int) -> int | None:
        """Raise a resource's mark towards `sequence`, and answer the mark it now has. Nothing where the mark did not rise.

        It rises to `sequence`, or to just below the lowest event of the
        resource that was not applied, whichever is lower. It never falls: a
        lower sequence is an event delivered again.
        """
        held_back = self._not_applied.get(resource)
        reached = sequence if not held_back else min(sequence, min(held_back) - 1)
        if reached <= self.of(resource):
            return None
        self._applied[resource] = reached
        self.unsaved = True
        return reached
