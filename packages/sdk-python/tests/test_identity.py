"""How a knowledge base and its principals are named, held to the tables every implementation runs.

`specs/src/principals/cases.json` for a person and a software agent, and
`specs/src/kb-identity/cases.json` for the knowledge base itself, of which this
SDK runs every case that states a domain: reading a knowledge base's own
configuration is the launcher's and the gateway's.
"""

import pytest
from spec import SPEC, JsonObject, objects, read, text

from semiont.identifiers import UserId
from semiont.identity import agent_address, agent_did, agent_name, kb_did, kb_resource, person_did

PRINCIPALS = read(SPEC / "principals/cases.json")
PEOPLE = objects(PRINCIPALS["people"], "people")
AGENTS = objects(PRINCIPALS["agents"], "agents")
KNOWLEDGE_BASES = [case for case in objects(read(SPEC / "kb-identity/cases.json")["cases"], "cases") if case["domain"] is not None]


def why(case: JsonObject) -> str:
    return text(case["why"], "why")


@pytest.mark.parametrize("case", PEOPLE, ids=why)
def test_a_person_is_named_as_the_table_names_one(case: JsonObject) -> None:
    did = person_did(text(case["domain"], "domain"), text(case["subject"], "subject"))
    assert type(did) is UserId
    assert did == case["did"]


@pytest.mark.parametrize("case", AGENTS, ids=why)
def test_a_software_agent_is_named_as_the_table_names_one(case: JsonObject) -> None:
    domain, provider, model = (text(case[name], name) for name in ("domain", "provider", "model"))
    did = agent_did(domain, provider, model)
    assert type(did) is UserId
    assert (did, agent_address(domain, provider, model), agent_name(provider, model)) == (case["did"], case["email"], case["name"])


@pytest.mark.parametrize("case", KNOWLEDGE_BASES, ids=why)
def test_a_knowledge_base_is_named_by_its_domain(case: JsonObject) -> None:
    domain = text(case["domain"], "domain")
    assert (kb_did(domain), kb_resource(domain)) == (case["did"], case["resource"])


def test_the_tables_were_read() -> None:
    assert len(PEOPLE) >= 8
    assert len(AGENTS) >= 5
    assert len(KNOWLEDGE_BASES) >= 5
