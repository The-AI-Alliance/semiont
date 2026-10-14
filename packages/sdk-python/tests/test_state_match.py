"""The match unit: a search asked for on the client's own bus is run, and answered there under the asker's id.

Ported from the Rust SDK's tests of its `MatchStateUnit` (`packages/sdk-rust/tests/state.rs`),
test for test: the same rules, in the same order.
"""

import asyncio
from collections.abc import Mapping
from typing import final, override

from aio import pass_time, run, soon, turns
from kb import answer, asked_for
from pydantic import JsonValue

from semiont.channels import BRIDGED_CHANNELS, MATCH_SEARCH_FAILED, MATCH_SEARCH_RESULTS
from semiont.identifiers import AnnotationId, ResourceId
from semiont.model import written
from semiont.state import MatchStateUnit
from semiont.testing import DropReply, FaultyTransport, create_test_client
from semiont.testing.axioms import AxiomSubject, Fresh, assert_state_unit_axioms
from semiont.timing import BUS_REQUEST_TIMEOUT_MS
from semiont.transport import Frame
from semiont.types import GatheredContext, MatchSearchFailed, MatchSearchRequest

RESOURCE, REFERENCE = ResourceId("res-1"), AnnotationId("ref-1")
CONTEXT: Mapping[str, JsonValue] = {
    "focus": {
        "kind": "resource",
        "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "A resource", "description": None, "representations": []},
    },
    "graph": {"nodes": [], "edges": []},
    "metadata": {},
}


def _a_clients_stream() -> FaultyTransport:
    """A transport whose stream carries what a client's does: the replies and the broadcasts, and not the requests.

    So the unit hears what this client asked for, and never the search it sent
    over the wire in answer, which would otherwise come back to it as a new
    request. Nothing on it answers: each test answers itself.
    """
    return FaultyTransport([DropReply()], make_response=lambda operation, payload: None, channels=BRIDGED_CHANNELS)


def _search_request() -> MatchSearchRequest:
    return MatchSearchRequest(resource_id=RESOURCE, reference_id=REFERENCE, context=GatheredContext.model_validate(CONTEXT))


def test_match_runs_the_search_it_is_asked_for_and_answers_under_the_askers_id() -> None:
    async def scenario() -> None:
        made = create_test_client(transport=_a_clients_stream())
        async with made.client as client, MatchStateUnit(client), client.bus.frames(MATCH_SEARCH_RESULTS) as results:
            await turns()
            assert asked_for(made.transport, "match:search-requested") == []

            client.match.request_search(_search_request(), "asked-1")
            await turns()
            [sent] = asked_for(made.transport, "match:search-requested")
            assert (sent.payload["referenceId"], sent.payload["resourceId"]) == ("ref-1", "res-1")

            answer(made.transport, sent, [])
            # The wire's reply, under the request's own id, and then the unit's, under the asker's.
            wire = await soon(anext(results))
            ours = await soon(anext(results))
            assert (wire.correlation_id, ours.correlation_id) == (sent.correlation_id, "asked-1")
            assert written(ours.payload) == {"referenceId": "ref-1", "response": []}

    run(scenario())


def test_match_says_a_search_that_failed_with_its_reference_and_the_reason() -> None:
    async def scenario() -> None:
        made = create_test_client(transport=_a_clients_stream())
        async with made.client as client, MatchStateUnit(client), client.bus.frames(MATCH_SEARCH_FAILED) as failures:
            client.match.request_search(_search_request(), "asked-1")
            await turns()
            [sent] = asked_for(made.transport, "match:search-requested")
            made.transport.deliver(
                Frame(
                    channel="match:search-failed",
                    payload={"referenceId": "ref-1", "error": "the index is down"},
                    correlation_id=sent.correlation_id,
                )
            )

            wire = await soon(anext(failures))
            ours = await soon(anext(failures))
            assert (wire.correlation_id, ours.correlation_id) == (sent.correlation_id, "asked-1")
            assert ours.payload == MatchSearchFailed(reference_id=REFERENCE, error="the index is down")

    run(scenario())


def test_match_says_a_search_never_answered_as_failed_at_the_requests_deadline() -> None:
    async def scenario() -> None:
        made = create_test_client(transport=_a_clients_stream())
        async with made.client as client, MatchStateUnit(client), client.bus.frames(MATCH_SEARCH_FAILED) as failures:
            client.match.request_search(_search_request(), "asked-1")
            failure = asyncio.ensure_future(anext(failures))
            await pass_time(BUS_REQUEST_TIMEOUT_MS / 1000 - 1)
            assert not failure.done()
            await pass_time(2)

            failed = await soon(failure)
            assert (failed.correlation_id, failed.payload.reference_id) == ("asked-1", "ref-1")

    run(scenario())


def test_match_disposed_runs_nothing() -> None:
    async def scenario() -> None:
        made = create_test_client(transport=_a_clients_stream())
        async with made.client as client:
            unit = MatchStateUnit(client)
            unit.dispose()

            client.match.request_search(_search_request(), "asked-1")
            await turns()

            assert made.transport.emitted == []
            # What it was given is not its to end.
            assert not client.bus.destroyed

    run(scenario())


@final
class Matches(AxiomSubject[MatchStateUnit]):
    """How the axioms reach a match unit: it holds no state, and is given its client."""

    @override
    def setup(self) -> Fresh[MatchStateUnit]:
        made = create_test_client(transport=_a_clients_stream())
        return Fresh(MatchStateUnit(made.client)).given(made.client)


def test_match_keeps_the_state_unit_axioms() -> None:
    assert_state_unit_axioms(Matches())
