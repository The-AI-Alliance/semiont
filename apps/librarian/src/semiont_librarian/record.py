"""What a Librarian reads of the record from the state volume: a resource's view, and what the knowledge base calls its people.

The Archivist writes both, and a Librarian only reads them
(`docs/protocol/LIBRARIAN.md` § What it answers, § Names). Each is a file
under the knowledge base's state directory, which is
`semiont/<the knowledge base's name>` in the state volume:

- a resource's view at `resources/<ab>/<cd>/<resourceId>.json`, where the
  two directory names are the id's shard (`semiont_service.shard`);
- the people projection at `projections/__system__/people.json`.

The Archivist writes a file whole, by renaming a finished one onto its path,
so a reader sees a whole document or none. A file is read off the loop, on a
thread, and is held to the shape its schema states (`ResourceView`,
`PeopleProjection`): what is there and is not that shape is a failure that
names the file, and is never taken for a file that is not there.
"""

import asyncio
from collections.abc import Mapping
from pathlib import Path
from typing import Final, final, override

from semiont.identifiers import ResourceId
from semiont.types import PeopleProjection, PersonProfile, ResourceView
from semiont_service.shard import shard_path

from semiont_librarian.reads import People, PeopleUnread, Views

__all__ = ["FilePeople", "FileViews", "ViewUnread"]


@final
class ViewUnread(Exception):
    """A resource's view could not be read: its file is there, and is not what its schema states, or could not be opened.

    A resource with no view is not this: its view is `None`.
    """


def _held(path: Path) -> bytes | None:
    """What a file holds. `None` for one that is not there. Raises `OSError` for one that is there and cannot be read."""
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


@final
class FileViews(Views):
    """The views of the knowledge base whose state directory is `state_dir`, read from its files."""

    def __init__(self, state_dir: Path) -> None:
        self._resources: Final = state_dir / "resources"

    def _read(self, resource_id: ResourceId) -> ResourceView | None:
        ab, cd = shard_path(resource_id)
        path = self._resources / ab / cd / f"{resource_id}.json"
        try:
            held = _held(path)
            return None if held is None else ResourceView.model_validate_json(held)
        except (OSError, ValueError) as failure:
            # What a model refuses is a `ValueError`, and so is what is no JSON.
            raise ViewUnread(f"{path} is not a resource's view that can be read: {failure}") from failure

    @override
    async def get(self, resource_id: ResourceId) -> ResourceView | None:
        """A resource's view, as its file states it. `None` where there is no file. Raises `ViewUnread` for a file that is no view."""
        return await asyncio.to_thread(self._read, resource_id)


@final
class FilePeople(People):
    """The people projection of the knowledge base whose state directory is `state_dir`, read from its file."""

    def __init__(self, state_dir: Path) -> None:
        self._path: Final = state_dir / "projections" / "__system__" / "people.json"

    def _read(self) -> Mapping[str, PersonProfile]:
        try:
            held = _held(self._path)
            return {} if held is None else PeopleProjection.model_validate_json(held).people
        except (OSError, ValueError) as failure:
            raise PeopleUnread(f"{self._path} is not a people projection that can be read: {failure}") from failure

    @override
    async def read(self) -> Mapping[str, PersonProfile]:
        """Each person's profile, by their DID. Nobody, where there is no file. Raises `PeopleUnread` for a file that is no projection."""
        return await asyncio.to_thread(self._read)
