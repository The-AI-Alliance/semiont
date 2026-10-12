"""How the people a reply mentions are named, held to `specs/src/librarian/naming-cases.json`.

It is the table every implementation of the naming runs, so that one reply
and one set of profiles give one named reply in any language. A case is run
through `named` and through nothing else: no projection is read.

A member of the table or of a case that nothing here reads fails.

After the table's cases comes what no case of it rests on: ids that are the
names of things every object of some language has, a person that states no
id, and the one read of the projection a reply is named over.
"""

import copy
import logging
from collections.abc import Mapping

import pytest
from aio import run
from pydantic import JsonValue
from rig import ADA, ADA_ID, LOVELACE, RECORDED, FakePeople
from semiont.types import PeopleProjection, PeopleProjectionPeopleValue
from spec import ROOT, JsonObject, objects, only, read, why

from semiont_librarian.naming import named, namer
from semiont_librarian.reads import PeopleUnread

TABLE = read(ROOT / "specs/src/librarian/naming-cases.json")
CASES = objects(TABLE["cases"], "cases")

TABLE_MEMBERS = ("$comment", "cases")
CASE_MEMBERS = ("why", "reply", "people", "named")


def people_of(case: JsonObject) -> Mapping[str, PeopleProjectionPeopleValue]:
    """The people a case states, as the people projection holds them: what the schema does not accept fails here."""
    return PeopleProjection.model_validate({"people": case["people"]}).people


def warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [record for record in caplog.records if record.name == "semiont_librarian" and record.levelno == logging.WARNING]


# ── The table's cases ─────────────────────────────────────────────────


def test_the_table_has_cases_that_name_someone_and_cases_that_name_no_one() -> None:
    only(TABLE, TABLE_MEMBERS, "the table")
    assert CASES, "the table has no case"
    for case in CASES:
        only(case, CASE_MEMBERS, why(case))
        assert set(CASE_MEMBERS) <= set(case), why(case)
    assert any(case["reply"] != case["named"] for case in CASES)
    assert any(case["reply"] == case["named"] for case in CASES)


def test_each_case_is_told_from_the_others_by_its_why() -> None:
    told = [why(case) for case in CASES]
    assert len(set(told)) == len(told)


@pytest.mark.parametrize("case", CASES, ids=[why(case) for case in CASES])
def test_a_reply_is_named_as_the_table_states(case: JsonObject) -> None:
    reply = case["reply"]
    as_it_was = copy.deepcopy(reply)
    assert named(reply, people_of(case)) == case["named"]
    # The reply that was handed in is as it was: what is named is a copy.
    assert reply == as_it_was


# ── What no case of the table rests on ────────────────────────────────


@pytest.mark.parametrize("identity", ["constructor", "toString", "__proto__", "__class__", "get", "name"])
def test_a_person_whose_id_names_something_every_object_has_is_named_only_by_a_profile(identity: str) -> None:
    person: JsonObject = {"@type": "Person", "@id": identity}
    assert named(person, LOVELACE) == person
    assert named(person, {}) == person
    # With a profile under that very id, the person is named as any other is.
    profiled = {identity: PeopleProjectionPeopleValue(name="A name", since=RECORDED)}
    assert named(person, profiled) == {**person, "name": "A name"}


@pytest.mark.parametrize("identity", [None, 7, True, ["did:web:example.org:users:ada"], {"@id": "did:web:example.org:users:ada"}])
def test_a_person_whose_id_is_not_text_is_left_as_it_is(identity: JsonValue) -> None:
    person: JsonObject = {"@type": "Person", "@id": identity, "name": "A name it carried"}
    assert named(person, LOVELACE) == person


def test_a_person_that_states_no_id_is_left_as_it_is() -> None:
    person: JsonObject = {"@type": "Person", "name": "A name it carried"}
    profiles = {**LOVELACE, "None": PeopleProjectionPeopleValue(name="Nobody", since=RECORDED)}
    assert named(person, profiles) == person


def test_a_name_is_put_where_the_person_carried_one_and_last_where_it_carried_none() -> None:
    carried: JsonObject = {"@type": "Person", "name": "59523dd4", "@id": ADA_ID, "nickname": "ada"}
    named_one = named(carried, LOVELACE)
    assert isinstance(named_one, dict)
    assert list(named_one) == ["@type", "name", "@id", "nickname"]
    unnamed = named(ADA, LOVELACE)
    assert isinstance(unnamed, dict)
    assert list(unnamed) == ["@type", "@id", "name"]


def test_a_namer_reads_the_projection_once_however_many_people_the_reply_mentions() -> None:
    people = FakePeople(LOVELACE)
    name = run(namer(people))
    reply: JsonObject = {"creator": ADA, "wasAttributedTo": [ADA, ADA]}
    ada_named: JsonObject = {**ADA, "name": "Ada Lovelace"}
    assert name(reply) == {"creator": ada_named, "wasAttributedTo": [ada_named, ada_named]}
    assert name(ADA) == ada_named
    assert people.reads == 1


def test_a_knowledge_base_with_no_projection_names_no_one_and_nothing_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        name = run(namer(FakePeople()))
    reply: JsonObject = {"creator": ADA}
    assert name(reply) == reply
    assert warnings(caplog) == []


def test_a_projection_that_cannot_be_read_is_logged_as_a_warning_and_the_reply_names_no_one(caplog: pytest.LogCaptureFixture) -> None:
    people = FakePeople(LOVELACE)
    people.failing = PeopleUnread("people.json is not a people projection that can be read")
    with caplog.at_level(logging.WARNING, logger="semiont_librarian"):
        name = run(namer(people))
    reply: JsonObject = {"creator": ADA}
    assert name(reply) == reply
    (said,) = warnings(caplog)
    assert said.getMessage() == "People projection unreadable: this reply names no one"
    assert vars(said)["error"] == "people.json is not a people projection that can be read"
    assert people.reads == 1
