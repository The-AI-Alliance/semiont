"""What the tests of a held job share: a real client over the SDK's doubles, and a job handed over by a real claim.

The transport is the SDK's scriptable one, naming the channels a worker's
stream names and no others (`WORKER_CHANNELS`): a request whose reply those
channels could not carry is refused where it is made, so every test that
runs a job here also holds that the worker's stream names what the worker
awaits. The test plays the dispatcher and the record by what it gives
`Parties`, the Archivist by the domain it says the knowledge base is, and the
gateway by what it seeds on `Parties.content`: a resource's bytes, and the
Smelter's text of a PDF. It reads back everything the worker sent, and every
read the worker made of the gateway.
"""

import asyncio
from collections import deque
from collections.abc import Mapping, Sequence
from typing import Final, final

from pydantic import JsonValue
from semiont.claims import ClaimRefusal, Claims, HeldJob
from semiont.client import SemiontClient
from semiont.identifiers import ResourceId, UserId
from semiont.identity import kb_did
from semiont.testing import FaultyTransport, create_test_client, refuse_unscripted_operation
from semiont.transport import Content, Frame
from semiont.types import JobFilter, MarkJobFilter, MarkJobFilterParams, YieldJobFilter
from semiont_inference.interface import InferenceClient, InferenceLimits
from semiont_inference.mock import MockInferenceClient
from standing_in import GENERATOR

from semiont_worker.agent import WORKER_CHANNELS
from semiont_worker.held_job import run_job

EVERY_JOB: Final[list[JobFilter]] = [
    MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="highlighting")),
    MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="commenting")),
    MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="assessing")),
    MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="linking")),
    MarkJobFilter(job_type="mark", params=MarkJobFilterParams(motivation="tagging")),
    YieldJobFilter(job_type="yield"),
]

DOMAIN: Final = "test.local"
"""The domain the knowledge base says it is, unless a test says another."""

KB: Final[UserId] = kb_did(DOMAIN)
"""The knowledge base's DID: what everything a test records names, unless the test runs another's claims (`conftest.served`)."""

TEXT: Final = "Ada Lovelace published the first program in 1843. Charles Babbage designed the engine in London.\n"

SOURCE: Final = "res-source"
"""The resource the jobs here are about."""

LIMITS: Final = InferenceLimits(context_tokens=8192, max_output_tokens=8192, output_tokens_per_hour=None, accepts_temperature=True)


def answering(*replies: str) -> MockInferenceClient:
    """A model that answers each call the next of `replies`, having finished each."""
    return MockInferenceClient(list(replies), stop_reasons=["end_turn"] * len(replies), limits=LIMITS)


def job(job_id: str, job_type: str, params: Mapping[str, JsonValue], **metadata: JsonValue) -> dict[str, JsonValue]:
    """A job as the dispatcher hands one to whoever claims it, about `SOURCE` unless its params say otherwise."""
    return {
        "status": "running",
        "metadata": {
            "id": job_id,
            "type": job_type,
            "userId": "did:web:test.local:users:requester",
            "created": "2026-01-01T00:00:00.000Z",
            "retryCount": 0,
            "maxRetries": 3,
            **metadata,
        },
        "params": {"resourceId": SOURCE, **params},
        "startedAt": "2026-01-01T00:00:01.000Z",
        "progress": {},
    }


@final
class Parties:
    """The dispatcher, the record and the Archivist as a test scripts them, the gateway's content as seeded, and all the worker sent."""

    def __init__(self) -> None:
        self.domain: str | None = DOMAIN
        """The domain the knowledge base answers `browse:kb-requested` with: `None` where it answers `browse:kb-failed`."""
        self.queue: Final[deque[dict[str, JsonValue]]] = deque()
        """Jobs waiting to be claimed. A claim with none waiting is answered that nothing is pending."""
        self.descriptors: Final[dict[str, JsonValue]] = {}
        """The description the record answers for each resource it has."""
        self.commits: Final[list[tuple[str, list[JsonValue]]]] = []
        """Every batch the record was sent: the resource, and its annotations."""
        self.commit_refused: str | None = None
        """Why the record refuses a batch, where a test has it refuse."""
        self.claim_refused: Mapping[str, JsonValue] | None = None
        """What the dispatcher refuses a claim with, where a test has it refuse."""
        self.claims: int = 0
        """How many claims the dispatcher was sent."""
        self.transport: Final = FaultyTransport(make_response=self._answer, channels=WORKER_CHANNELS)
        self.transport.refuse_when(self._refusal)
        made = create_test_client(transport=self.transport)
        self.client: Final = made.client
        self.content: Final = made.content
        """What the gateway reads back, as a test seeds it, and every read and upload the worker made of it."""

    def text_resource(self, text: str = TEXT, media_type: str = "text/markdown") -> None:
        """Give the record and the gateway a resource `SOURCE` of `text`."""
        self.describe(SOURCE, media_type)
        self.content.seed(ResourceId(SOURCE), Content(data=text.encode("utf-8"), content_type=media_type))

    def describe(self, resource_id: str, media_type: str) -> None:
        self.descriptors[resource_id] = {
            "@context": "https://schema.org",
            "@id": resource_id,
            "name": "A resource",
            "representations": [{"mediaType": media_type, "storageUri": f"file://test/{resource_id}", "rel": "original"}],
        }

    def _refusal(self, operation: str, payload: Mapping[str, JsonValue]) -> Mapping[str, JsonValue] | None:
        if operation == "job:claim":
            self.claims += 1
        match operation:
            case "job:claim" if self.claim_refused is not None:
                return self.claim_refused
            case "job:claim" if not self.queue:
                return {"code": "none-pending", "message": "No pending job matches"}
            case "browse:kb-requested" if self.domain is None:
                return {"message": "This knowledge base declares no domain"}
            case "browse:resource-requested" if payload.get("resourceId") not in self.descriptors:
                return {"code": "not-found", "message": f"Resource not found: {payload.get('resourceId')}"}
            case "mark:commit" if self.commit_refused is not None:
                return {"message": self.commit_refused}
            case _:
                return None

    def _answer(self, operation: str, payload: Mapping[str, JsonValue]) -> JsonValue | None:
        resource_id = payload.get("resourceId")
        match operation:
            case "job:claim":
                return self.queue.popleft()
            case "browse:kb-requested":
                return {"name": "A knowledge base", "domain": self.domain}
            case "browse:resource-requested":
                assert isinstance(resource_id, str)
                return {"resource": self.descriptors[resource_id], "lastSequence": 1}
            case "mark:commit":
                annotations = payload.get("annotations")
                assert isinstance(resource_id, str)
                assert isinstance(annotations, list)
                self.commits.append((resource_id, annotations))
                return {
                    "persisted": len(annotations),
                    "annotationIds": [annotation["id"] for annotation in annotations if isinstance(annotation, dict)],
                }
            case _:
                refuse_unscripted_operation(operation, payload)

    def sent(self, channel: str) -> list[Mapping[str, JsonValue]]:
        """The payloads the worker sent on `channel`, in order."""
        return [frame.payload for frame in self.transport.emitted if frame.channel == channel]

    def sequence(self) -> list[str]:
        """The channels of everything the worker sent but its progress reports and its claims, in order."""
        return [frame.channel for frame in self.transport.emitted if frame.channel not in ("job:report-progress", "job:claim")]

    def frames(self) -> Sequence[Frame]:
        return self.transport.emitted


async def claimed(parties: Parties, claims: Claims) -> HeldJob:
    """The next job `claims` hands out, which a test expects to be one."""
    handed = await anext(claims)
    assert not isinstance(handed, ClaimRefusal), f"the claim was refused: {handed}"
    return handed


async def worked(
    parties: Parties, handed_over: dict[str, JsonValue], inference: InferenceClient, accepts: Sequence[JobFilter] = EVERY_JOB
) -> None:
    """Hand a job over by a real claim, and run it with `run_job` until it has settled it."""
    parties.queue.append(handed_over)
    client: SemiontClient[FaultyTransport] = parties.client
    async with client, client.job.claim(accepts) as claims:
        held = await claimed(parties, claims)
        await run_job(held, client=client, inference=inference, generator=GENERATOR, accepts=accepts)
        # The claim the settle made is answered before the claiming is stopped.
        for _ in range(10):
            await asyncio.sleep(0)
    await parties.transport.close()
