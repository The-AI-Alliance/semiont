"""The two files a Librarian reads of the record: a resource's view, and the people projection.

Each is written here where the Archivist writes it, under a state directory
of the test's own, and read by the reader a Librarian is handed. A file that
is there and is not what its schema states is a failure that names the file.
It is never taken for a file that is not there.
"""

import json
import threading
from pathlib import Path

import pytest
from aio import run
from pydantic import JsonValue
from semiont.identifiers import ResourceId
from semiont.model import written
from semiont.types import PersonProfile
from semiont_service.shard import shard_path
from spec import JsonObject

from semiont_librarian.reads import PeopleUnread
from semiont_librarian.record import FilePeople, FileViews, ViewUnread

R1 = ResourceId("res-1")

PEOPLE: JsonObject = {
    "people": {
        "did:web:example.org:users:ada": {"name": "Ada Lovelace", "since": "2020-03-04T05:06:07.000Z"},
        "did:web:example.org:users:grace": {"name": "Grace Hopper", "since": "2020-03-04T05:06:08.000Z"},
    }
}
"""A people projection, as the Archivist writes one."""


def view_of(resource: str) -> JsonObject:
    """A resource's view, as the Archivist writes one: its description, one annotation on it, and the last event applied."""
    return {
        "resource": {
            "@context": "https://schema.org/",
            "@id": resource,
            "name": "Black Hawk",
            "representations": [{"mediaType": "text/plain", "storageUri": "file://black-hawk.txt", "rel": "original"}],
        },
        "annotations": {
            "resourceId": resource,
            "annotations": [
                {
                    "@context": "http://www.w3.org/ns/anno.jsonld",
                    "type": "Annotation",
                    "id": "ann-1",
                    "motivation": "highlighting",
                    "target": {"source": resource, "selector": {"type": "TextPositionSelector", "start": 0, "end": 5}},
                    "created": "2020-03-04T05:06:07.000Z",
                }
            ],
            "version": 3,
            "updatedAt": "2020-03-04T05:06:07.000Z",
        },
        "lastSequence": 3,
    }


def put(path: Path, document: JsonValue) -> Path:
    """Write a document where a file of the record is, indented by two spaces as the Archivist writes one."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document, indent=2), encoding="utf-8")
    return path


def view_path(state_dir: Path, resource: str) -> Path:
    """Where a resource's view is, under a state directory."""
    ab, cd = shard_path(resource)
    return state_dir / "resources" / ab / cd / f"{resource}.json"


def people_path(state_dir: Path) -> Path:
    """Where the people projection is, under a state directory."""
    return state_dir / "projections" / "__system__" / "people.json"


# ── A resource's view ─────────────────────────────────────────────────


def test_a_view_is_read_from_the_file_the_archivist_writes_it_to(tmp_path: Path) -> None:
    put(view_path(tmp_path, R1), view_of(R1))
    read = run(FileViews(tmp_path).get(R1))
    assert read is not None
    assert written(read) == view_of(R1)
    assert (read.resource.id, read.last_sequence, [each.id for each in read.annotations.annotations]) == (R1, 3, ["ann-1"])


def test_a_view_is_filed_under_resources_by_the_two_halves_of_its_id_s_shard(tmp_path: Path) -> None:
    # The shard of `a` is its one code unit, 97, which is 0061 in four hex digits (`specs/src/archivist/shard-cases.json`).
    put(tmp_path / "resources" / "00" / "61" / "a.json", view_of("a"))
    read = run(FileViews(tmp_path).get(ResourceId("a")))
    assert read is not None
    assert read.resource.id == "a"


def test_a_resource_with_no_file_has_no_view(tmp_path: Path) -> None:
    views = FileViews(tmp_path)
    # Neither where the state directory holds no view at all, nor beside the view of another resource.
    assert run(views.get(R1)) is None
    put(view_path(tmp_path, "res-2"), view_of("res-2"))
    assert run(views.get(R1)) is None


@pytest.mark.parametrize(
    "held",
    ["", "{", '{"resource": ', "null", "[]", "{}"],
    ids=["nothing", "an object cut short", "a view cut short", "null", "a list", "an object with no member"],
)
def test_a_file_that_is_no_view_is_a_failure_that_names_the_file_and_is_not_taken_for_no_view(held: str, tmp_path: Path) -> None:
    path = view_path(tmp_path, R1)
    path.parent.mkdir(parents=True)
    path.write_text(held, encoding="utf-8")
    with pytest.raises(ViewUnread) as refused:
        run(FileViews(tmp_path).get(R1))
    assert str(path) in str(refused.value)


def test_a_view_with_a_member_its_schema_does_not_state_or_without_one_it_requires_is_a_failure(tmp_path: Path) -> None:
    path = view_path(tmp_path, R1)
    more = {**view_of(R1), "writtenBy": "nobody"}
    put(path, more)
    with pytest.raises(ViewUnread) as refused:
        run(FileViews(tmp_path).get(R1))
    assert str(path) in str(refused.value)
    less = {member: stated for member, stated in view_of(R1).items() if member != "lastSequence"}
    put(path, less)
    with pytest.raises(ViewUnread):
        run(FileViews(tmp_path).get(R1))


def test_a_view_s_file_that_cannot_be_opened_is_a_failure_that_names_it(tmp_path: Path) -> None:
    path = view_path(tmp_path, R1)
    # A directory where the file is to be: it is there, and it cannot be read as a file.
    path.mkdir(parents=True)
    with pytest.raises(ViewUnread) as refused:
        run(FileViews(tmp_path).get(R1))
    assert str(path) in str(refused.value)


def test_a_file_is_read_off_the_loop_s_thread(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    put(view_path(tmp_path, R1), view_of(R1))
    put(people_path(tmp_path), PEOPLE)
    read_on: list[bool] = []
    as_it_reads = Path.read_bytes

    def watched(path: Path) -> bytes:
        read_on.append(threading.current_thread() is threading.main_thread())
        return as_it_reads(path)

    monkeypatch.setattr(Path, "read_bytes", watched)
    assert run(FileViews(tmp_path).get(R1)) is not None
    assert run(FilePeople(tmp_path).read())
    assert read_on == [False, False]


# ── The people projection ─────────────────────────────────────────────


def test_the_people_are_read_from_the_file_the_archivist_writes_them_to(tmp_path: Path) -> None:
    put(people_path(tmp_path), PEOPLE)
    assert run(FilePeople(tmp_path).read()) == {
        "did:web:example.org:users:ada": PersonProfile(name="Ada Lovelace", since="2020-03-04T05:06:07.000Z"),
        "did:web:example.org:users:grace": PersonProfile(name="Grace Hopper", since="2020-03-04T05:06:08.000Z"),
    }


def test_a_knowledge_base_with_no_projection_file_calls_no_one_anything(tmp_path: Path) -> None:
    people = FilePeople(tmp_path)
    assert run(people.read()) == {}
    # Nor where the directory of the projections is there and the file is not.
    people_path(tmp_path).parent.mkdir(parents=True)
    assert run(people.read()) == {}


def test_a_projection_of_no_people_calls_no_one_anything(tmp_path: Path) -> None:
    put(people_path(tmp_path), {"people": {}})
    assert run(FilePeople(tmp_path).read()) == {}


def test_the_projection_is_read_again_at_every_read(tmp_path: Path) -> None:
    people = FilePeople(tmp_path)
    assert run(people.read()) == {}
    put(people_path(tmp_path), PEOPLE)
    assert sorted(run(people.read())) == ["did:web:example.org:users:ada", "did:web:example.org:users:grace"]


@pytest.mark.parametrize(
    "held",
    [
        "",
        "{",
        "null",
        "[]",
        "{}",
        '{"people": []}',
        '{"people": {"did:web:example.org:users:ada": {"name": "Ada Lovelace"}}}',
        '{"people": {}, "more": 1}',
    ],
    ids=[
        "nothing",
        "cut short",
        "null",
        "a list",
        "no people",
        "people that are a list",
        "a profile with no moment",
        "a member too many",
    ],
)
def test_a_file_that_is_no_people_projection_is_unread_and_names_the_file(held: str, tmp_path: Path) -> None:
    path = people_path(tmp_path)
    path.parent.mkdir(parents=True)
    path.write_text(held, encoding="utf-8")
    with pytest.raises(PeopleUnread) as refused:
        run(FilePeople(tmp_path).read())
    assert str(path) in str(refused.value)


def test_a_projection_s_file_that_cannot_be_opened_is_unread(tmp_path: Path) -> None:
    path = people_path(tmp_path)
    path.mkdir(parents=True)
    with pytest.raises(PeopleUnread) as refused:
        run(FilePeople(tmp_path).read())
    assert str(path) in str(refused.value)
