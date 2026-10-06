"""The client's surface against `specs/src/client/surface.json`.

Every method the table lists is called as each of its cases states, and what
the call did first is held to the row. A row with no call here fails, and so
does a call here with no row: the table and this SDK list the same methods.

What a method does first is one of: a request of a bus operation, a frame sent
over the wire, a frame published on the client's own bus, a call of the
content transport, a call of the gateway, or reading a channel of the client's
own bus. A call that is awaited is driven on a task of its own, and what it
resolves with is not this test's to judge: a case holds what the call did, not
what it was answered.

Signatures are read by `scripts/lint/check-client-surface.mjs`.
"""

import asyncio
from collections.abc import Awaitable, Callable, Mapping
from typing import Final, final

import pytest
from aio import run, soon
from doubles import RecordingContent, RecordingGateway
from pydantic import JsonValue, TypeAdapter
from scripted_transport import Scripted
from spec import SPEC, JsonObject, objects, read, text

from semiont.bus import Typed
from semiont.channels import BRIDGED_CHANNELS
from semiont.client import SemiontClient
from semiont.identifiers import AnnotationId, JobId, ResourceId
from semiont.model import WireModel, written
from semiont.namespaces.mark import MarkAssistOptions
from semiont.transport import Frame, PutBinaryRequest
from semiont.types import (
    AnnotationSelector,
    BindBodyOperation,
    BindInitiateCommand,
    BrowseDirectoryRequestSort,
    CreateAnnotationRequest,
    GatheredContext,
    GenerationJobParams,
    JobCancelRequestJobType,
    MarkAssistRequestEventOptions,
    MarkSubmitEvent,
    MatchSearchRequest,
    Motivation,
    ResourceErrorEvent,
    TagSchema,
)

# The SDK this runner is, as the table's `absent` names it.
SDK: Final = "python"

TABLE = read(SPEC / "client/surface.json")


def fixtures() -> JsonObject:
    stated = TABLE["fixtures"]
    assert isinstance(stated, dict)
    return stated


FIXTURES: Final = fixtures()

type Client = SemiontClient[Scripted]
type Args = Mapping[str, JsonValue]

_MOTIVATION = TypeAdapter[Motivation](Motivation)
_SELECTOR = TypeAdapter[AnnotationSelector](AnnotationSelector)
_OPERATIONS = TypeAdapter[list[BindBodyOperation]](list[BindBodyOperation])
_SORT = TypeAdapter[BrowseDirectoryRequestSort](BrowseDirectoryRequestSort)
_JOB_CATEGORY = TypeAdapter[JobCancelRequestJobType](JobCancelRequestJobType)
_NAMES = TypeAdapter[list[str]](list[str])


def resolved(value: JsonValue) -> JsonValue:
    """`value` with each `{"$fixture": name}` replaced by the table's fixture."""
    if isinstance(value, list):
        return [resolved(item) for item in value]
    if not isinstance(value, dict):
        return value
    named = value.get("$fixture")
    if isinstance(named, str) and len(value) == 1:
        assert named in FIXTURES, f"the table has no fixture {named}"
        return FIXTURES[named]
    return {key: resolved(item) for key, item in value.items()}


def numbers(value: JsonValue) -> JsonValue:
    """`value` with every number as the number it is, however it was written: `200` and `200.0` are one JSON number."""
    if isinstance(value, bool):
        return value
    if isinstance(value, int | float):
        return float(value)
    if isinstance(value, list):
        return [numbers(item) for item in value]
    if isinstance(value, dict):
        return {key: numbers(item) for key, item in value.items()}
    return value


def rid(args: Args, name: str = "resourceId") -> ResourceId:
    return ResourceId(text(args[name], name))


def aid(args: Args, name: str = "annotationId") -> AnnotationId:
    return AnnotationId(text(args[name], name))


def options(args: Args) -> JsonObject:
    stated = args.get("options", {})
    assert isinstance(stated, dict)
    return stated


def whole(value: JsonValue, name: str) -> int:
    assert isinstance(value, int), f"{name} is not a whole number"
    assert not isinstance(value, bool), f"{name} is not a whole number"
    return value


def flag(value: JsonValue, name: str) -> bool:
    assert isinstance(value, bool), f"{name} is not a flag"
    return value


@final
class Filters:
    """The filters a list or a search is given. A filter this SDK has no argument for fails the case rather than going unsent."""

    def __init__(self, args: Args) -> None:
        stated = args.get("filters", {})
        assert isinstance(stated, dict)
        unknown = set(stated) - {"limit", "archived", "entityType"}
        assert not unknown, f"the case filters by {unknown}, which this SDK's lists do not take"
        self.limit = whole(stated["limit"], "limit") if "limit" in stated else None
        self.archived = flag(stated["archived"], "archived") if "archived" in stated else None
        self.entity_type = text(stated["entityType"], "entityType") if "entityType" in stated else None


def listed(client: Client, args: Args) -> Awaitable[object]:
    filters = Filters(args)
    if filters.limit is None:
        return client.browse.resources(archived=filters.archived, entity_type=filters.entity_type).fresh()
    return client.browse.resources(limit=filters.limit, archived=filters.archived, entity_type=filters.entity_type).fresh()


def found(client: Client, args: Args) -> Awaitable[object]:
    filters, search = Filters(args), text(args["search"], "search")
    if filters.limit is None:
        return client.match.resources(search, archived=filters.archived, entity_type=filters.entity_type).fresh()
    return client.match.resources(search, limit=filters.limit, archived=filters.archived, entity_type=filters.entity_type).fresh()


def directory(client: Client, args: Args) -> Awaitable[object]:
    # What the case does not state is what the SDK sends unasked.
    if "dirPath" not in args:
        return client.browse.files()
    return client.browse.files(text(args["dirPath"], "dirPath"), sort=_SORT.validate_python(args["sort"]))


def gathered_annotation(client: Client, args: Args) -> Awaitable[object]:
    window = options(args).get("contextWindow")
    if window is None:
        return client.gather.annotation(rid(args), aid(args))
    return client.gather.annotation(rid(args), aid(args), context_window=whole(window, "contextWindow"))


def gathered_resource(client: Client, args: Args) -> Awaitable[object]:
    stated = options(args)
    unknown = set(stated) - {"depth", "maxResources", "includeContent", "includeSummary", "excludeEntityTypes"}
    assert not unknown, f"the case states {unknown}, which gather.resource does not take"
    if "depth" not in stated:
        # Only an exclusion is stated, or nothing is.
        return client.gather.resource(rid(args), exclude_entity_types=_NAMES.validate_python(stated.get("excludeEntityTypes", [])))
    return client.gather.resource(
        rid(args),
        depth=whole(stated["depth"], "depth"),
        max_resources=whole(stated["maxResources"], "maxResources"),
        include_content=flag(stated["includeContent"], "includeContent"),
        include_summary=flag(stated["includeSummary"], "includeSummary"),
        exclude_entity_types=_NAMES.validate_python(stated.get("excludeEntityTypes", [])),
    )


def searched(client: Client, args: Args) -> Awaitable[object]:
    context, stated = GatheredContext.model_validate(args["context"]), options(args)
    if not stated:
        return client.match.search(rid(args), aid(args, "referenceId"), context)
    return client.match.search(
        rid(args),
        aid(args, "referenceId"),
        context,
        limit=whole(stated["limit"], "limit"),
        use_semantic_scoring=flag(stated["useSemanticScoring"], "useSemanticScoring"),
    )


def generated(client: Client, args: Args) -> Awaitable[object]:
    # How long the follower waits is the caller's own and has an argument of its own; the rest are the job's parameters.
    stated = dict(options(args))
    stall = stated.pop("stallDeadlineMs", None)
    params = GenerationJobParams.model_validate({**stated, "context": args["context"]})
    if stall is None:
        return client.yield_.from_context(params)
    return client.yield_.from_context(params, stall_deadline_ms=whole(stall, "stallDeadlineMs"))


def uploaded(client: Client, args: Args) -> Awaitable[object]:
    data = args["data"]
    assert isinstance(data, dict)
    return client.yield_.resource(
        PutBinaryRequest(
            name=text(data["name"], "name"),
            file=text(data["content"], "content").encode(),
            format=text(data["format"], "format"),
            storage_uri=text(data["storageUri"], "storageUri"),
        )
    )


def cloned(client: Client, args: Args) -> Awaitable[object]:
    stated = options(args)
    return client.yield_.create_from_token(
        token=text(stated["token"], "token"), name=text(stated["name"], "name"), content=text(stated["content"], "content")
    )


def polled(client: Client, args: Args) -> Awaitable[object]:
    return client.job.poll_until_complete(JobId(text(args["jobId"], "jobId")), every_ms=10, within_ms=50)


def hovered(client: Client, args: Args) -> None:
    hovering = args["annotationId"]
    client.beckon.hover(None if hovering is None else AnnotationId(text(hovering, "annotationId")))


# Every method this SDK's client has that is called, as the table names them: an awaitable for one that is awaited, nothing for a signal.
CALLS: Final[dict[tuple[str, str], Callable[[Client, Args], Awaitable[object] | None]]] = {
    ("frame", "addEntityType"): lambda client, args: client.frame.add_entity_type(text(args["type"], "type")),
    ("frame", "addEntityTypes"): lambda client, args: client.frame.add_entity_types(_NAMES.validate_python(args["types"])),
    ("frame", "addTagSchema"): lambda client, args: client.frame.add_tag_schema(TagSchema.model_validate(args["schema"])),
    ("browse", "resource"): lambda client, args: client.browse.resource(rid(args)).fresh(),
    ("browse", "resources"): listed,
    ("browse", "annotations"): lambda client, args: client.browse.annotations(rid(args)).fresh(),
    ("browse", "annotation"): lambda client, args: client.browse.annotation(rid(args), aid(args)).fresh(),
    ("browse", "entityTypes"): lambda client, _: client.browse.entity_types().fresh(),
    ("browse", "tagSchemas"): lambda client, _: client.browse.tag_schemas().fresh(),
    ("browse", "agents"): lambda client, _: client.browse.agents().fresh(),
    ("browse", "events"): lambda client, args: client.browse.events(rid(args)).fresh(),
    ("browse", "resourceContent"): lambda client, args: client.browse.resource_content(rid(args)),
    ("browse", "resourceGraph"): lambda client, args: client.browse.resource_graph(rid(args)),
    ("browse", "resourceAnchoredText"): lambda client, args: client.browse.resource_anchored_text(rid(args)),
    ("browse", "resourceRepresentation"): lambda client, args: client.browse.resource_representation(rid(args)),
    ("browse", "resourceRepresentationStream"): lambda client, args: client.browse.resource_representation_stream(rid(args)),
    ("browse", "resourceEvents"): lambda client, args: client.browse.resource_events(rid(args)),
    ("browse", "annotationHistory"): lambda client, args: client.browse.annotation_history(rid(args), aid(args)),
    ("browse", "files"): directory,
    ("browse", "kb"): lambda client, _: client.browse.kb(),
    ("browse", "click"): lambda client, args: client.browse.click(aid(args)),
    ("browse", "openResource"): lambda client, args: client.browse.open_resource(rid(args)),
    ("browse", "resourceViewed"): lambda client, args: client.browse.resource_viewed(rid(args)),
    ("mark", "annotation"): lambda client, args: client.mark.annotation(CreateAnnotationRequest.model_validate(args["input"])),
    ("mark", "delete"): lambda client, args: client.mark.delete(rid(args), aid(args)),
    ("mark", "archive"): lambda client, args: client.mark.archive(rid(args)),
    ("mark", "unarchive"): lambda client, args: client.mark.unarchive(rid(args)),
    ("mark", "updateEntityTypes"): lambda client, args: client.mark.update_entity_types(
        rid(args), _NAMES.validate_python(args["current"]), _NAMES.validate_python(args["updated"])
    ),
    ("mark", "assist"): lambda client, args: client.mark.assist(
        rid(args), _MOTIVATION.validate_python(args["motivation"]), MarkAssistOptions.model_validate(args["options"])
    ),
    ("mark", "request"): lambda client, args: client.mark.request(
        rid(args, "source"), _SELECTOR.validate_python(args["selector"]), _MOTIVATION.validate_python(args["motivation"])
    ),
    ("mark", "requestAssist"): lambda client, args: client.mark.request_assist(
        _MOTIVATION.validate_python(args["motivation"]), MarkAssistRequestEventOptions.model_validate(args["options"])
    ),
    ("mark", "submit"): lambda client, args: client.mark.submit(MarkSubmitEvent.model_validate(args["input"])),
    ("mark", "cancelPending"): lambda client, _: client.mark.cancel_pending(),
    ("mark", "dismissProgress"): lambda client, _: client.mark.dismiss_progress(),
    ("mark", "reportDeleteError"): lambda client, args: client.mark.report_delete_error(ResourceErrorEvent.model_validate(args["input"])),
    ("bind", "body"): lambda client, args: client.bind.body(rid(args), aid(args), _OPERATIONS.validate_python(args["operations"])),
    ("bind", "initiate"): lambda client, args: client.bind.initiate(BindInitiateCommand.model_validate(args["input"])),
    ("bind", "reportBodyError"): lambda client, args: client.bind.report_body_error(ResourceErrorEvent.model_validate(args["input"])),
    ("gather", "annotation"): gathered_annotation,
    ("gather", "resource"): gathered_resource,
    ("gather", "referencedBy"): lambda client, args: client.gather.referenced_by(rid(args)).fresh(),
    ("match", "search"): searched,
    ("match", "requestSearch"): lambda client, args: client.match.request_search(
        MatchSearchRequest.model_validate(args["input"]), text(args["correlationId"], "correlationId")
    ),
    ("match", "resources"): found,
    ("yield", "resource"): uploaded,
    ("yield", "fromContext"): generated,
    ("yield", "cloneToken"): lambda client, args: client.yield_.clone_token(rid(args)),
    ("yield", "fromToken"): lambda client, args: client.yield_.from_token(text(args["token"], "token")),
    ("yield", "createFromToken"): cloned,
    ("yield", "clone"): lambda client, _: client.yield_.clone(),
    ("beckon", "attention"): lambda client, args: client.beckon.attention(rid(args), aid(args)),
    ("beckon", "click"): lambda client, args: client.beckon.click(aid(args)),
    ("beckon", "openResource"): lambda client, args: client.beckon.open_resource(rid(args)),
    ("beckon", "sparkleAll"): lambda client, args: client.beckon.sparkle_all(aid(args)),
    ("beckon", "hover"): hovered,
    ("beckon", "sparkle"): lambda client, args: client.beckon.sparkle(aid(args)),
    ("job", "status"): lambda client, args: client.job.status(JobId(text(args["jobId"], "jobId"))),
    ("job", "pollUntilComplete"): polled,
    ("job", "cancelByType"): lambda client, args: client.job.cancel_by_type(_JOB_CATEGORY.validate_python(args["jobType"])),
    ("job", "cancel"): lambda client, args: client.job.cancel(JobId(text(args["jobId"], "jobId"))),
    ("job", "cancelRequest"): lambda client, args: client.job.cancel_request(_JOB_CATEGORY.validate_python(args["jobType"])),
    ("auth", "me"): lambda client, _: client.auth.me(),
    ("auth", "mediaToken"): lambda client, args: client.auth.media_token(rid(args)),
    ("auth", "protectedResourceMetadata"): lambda client, _: client.auth.protected_resource_metadata(),
    ("system", "healthCheck"): lambda client, _: client.system.health_check(),
    ("system", "status"): lambda client, _: client.system.status(),
}


async def first_payload[P: WireModel](events: Typed[P]) -> JsonObject:
    """The payload of the next event, as the wire would carry it."""
    return written((await anext(events)).payload)


# Every method that gives the events of a channel: what the next one carried.
EVENTS: Final[dict[tuple[str, str], Callable[[Client], Awaitable[JsonObject]]]] = {
    ("job", "queued"): lambda client: first_payload(client.job.queued()),
    ("job", "progress"): lambda client: first_payload(client.job.progress()),
    ("job", "complete"): lambda client: first_payload(client.job.complete()),
    ("job", "fail"): lambda client: first_payload(client.job.fail()),
}


@final
class World:
    """A client, and a record of what it asked of its transport, its content transport and its gateway."""

    def __init__(self) -> None:
        self.transport = Scripted(BRIDGED_CHANNELS, "open")
        self.transport.answers = {}
        self.content = RecordingContent()
        self.gateway = RecordingGateway()
        self.client: Client = SemiontClient(self.transport, self.content, self.gateway)
        self.calls: list[asyncio.Task[object]] = []

    def call(self, namespace: str, method: str, args: Args) -> None:
        """Start `namespace.method` as the case states it."""
        started = CALLS[namespace, method](self.client, args)
        if started is not None:
            self.calls.append(asyncio.ensure_future(started))

    async def over(self) -> None:
        """End the client, and every call still waiting. What each resolved with is nobody's to judge here."""
        await self.client.close()
        for call in self.calls:
            call.cancel()
        await asyncio.gather(*self.calls, return_exceptions=True)


async def eventually[T](what: str, seen: Callable[[], T | None]) -> T:
    """Wait, a second at most, for `seen` to give something."""
    for _ in range(200):
        found_now = seen()
        if found_now is not None:
            return found_now
        await asyncio.sleep(0.005)
    raise AssertionError(f"{what} did not happen")


def via(step: JsonObject) -> tuple[str, str]:
    """What a row, or one further step of a case, goes through: the kind, and what it names."""
    (kind, named), *others = ((kind, named) for kind, named in step.items() if kind != "sends")
    assert not others, "a step goes through exactly one thing"
    return kind, text(named, kind)


async def held_to(world: World, at: int, step: JsonObject, sends: JsonValue, why: str) -> None:
    """One step of a case: what was done, and what it was given."""
    kind, named = via(step)
    if kind in ("request", "emit"):
        frame: Frame = await eventually(
            f"{why}: a frame on {named}", lambda: world.transport.emitted[at] if len(world.transport.emitted) > at else None
        )
        assert frame.channel == named, why
        assert numbers(dict(frame.payload)) == numbers(sends), f"{why}: what was sent"
        assert frame.scope is None, f"{why}: it is sent globally"
        assert (frame.correlation_id is not None) == (kind == "request"), (
            f"{why}: a request carries a key of the client's making, and a frame nobody answers carries none"
        )
    elif kind == "content":
        operation, given = await eventually(
            f"{why}: a call of the content transport", lambda: world.content.calls[0] if world.content.calls else None
        )
        assert operation == named, why
        assert numbers(given) == numbers(sends), f"{why}: what it was given"
    elif kind == "gateway":
        operation, given = await eventually(
            f"{why}: a call of the gateway", lambda: world.gateway.calls[0] if world.gateway.calls else None
        )
        assert operation == named, why
        assert numbers(given) == numbers(sends), f"{why}: what it was given"
    else:
        raise AssertionError(f"{why}: a step through {kind} is not one this runner holds")


def cases() -> list[tuple[str, str, JsonObject, JsonObject]]:
    """Every case of every row this SDK has: the namespace, the method, the row and the case."""
    found_cases: list[tuple[str, str, JsonObject, JsonObject]] = []
    for namespace in objects(TABLE["namespaces"], "namespaces"):
        for row in objects(namespace["methods"], "methods"):
            absent = row.get("absent", {})
            assert isinstance(absent, dict)
            if SDK in absent:
                continue
            for case in objects(row["cases"], "cases"):
                found_cases.append((text(namespace["namespace"], "namespace"), text(row["method"], "method"), row, case))
    return found_cases


CASES = cases()


def named(case: tuple[str, str, JsonObject, JsonObject]) -> str:
    namespace, method, _, stated = case
    return f"{namespace}.{method} ({stated.get('why', 'as stated')})"


@pytest.mark.parametrize("case", CASES, ids=named)
def test_a_method_does_what_its_row_says(case: tuple[str, str, JsonObject, JsonObject]) -> None:
    namespace, method, row, stated = case
    why = named(case)
    step = row["via"]
    assert isinstance(step, dict)
    kind, channel = via(step)
    args = resolved(stated["args"])
    assert isinstance(args, dict)
    sends = resolved(stated["sends"])

    async def scenario() -> None:
        world = World()
        try:
            if "answers" in stated:
                assert world.transport.answers is not None
                world.transport.answers[channel] = [resolved(stated["answers"])]
            if kind == "local":
                published = world.client.bus.frames_on(channel)
                world.call(namespace, method, args)
                frame = await soon(anext(published), within=1.0)
                assert numbers(dict(frame.payload)) == numbers(sends), f"{why}: what was published"
                assert frame.correlation_id == stated.get("correlationId"), f"{why}: the key on its envelope"
                await asyncio.sleep(0.02)
                assert world.transport.emitted == [], f"{why}: a signal never reaches the wire"
            elif kind == "observes":
                assert isinstance(sends, dict)
                hearing = asyncio.ensure_future(EVENTS[namespace, method](world.client))
                await asyncio.sleep(0)
                world.client.bus.emit(channel, sends)
                assert numbers(await soon(hearing, within=1.0)) == numbers(sends), f"{why}: what was heard"
            else:
                world.call(namespace, method, args)
                await held_to(world, 0, step, sends, why)
                then = stated.get("then", [])
                for index, further in enumerate(objects(then, "then")):
                    await held_to(world, index + 1, further, resolved(further["sends"]), why)
        finally:
            await world.over()

    run(scenario())


def test_the_table_and_this_sdk_list_the_same_methods() -> None:
    assert sorted({(namespace, method) for namespace, method, _, _ in CASES}) == sorted([*CALLS, *EVENTS])
    assert len(CALLS) + len(EVENTS) == 70
    shapes = TABLE["shapes"]
    assert isinstance(shapes, dict)
    assert set(shapes) == {"promise", "stream", "upload", "cache", "signal", "count", "events"}


def test_every_option_of_an_assist_is_one_the_table_has_a_case_for() -> None:
    # `MarkAssistOptions` restates what a job takes, as the other SDKs' do. The table's cases are what holds it there:
    # each of its options is sent under its own name in one of them, and it has no option they do not send.
    stated: set[str] = set()
    for namespace, method, _, case in CASES:
        if (namespace, method) == ("mark", "assist"):
            args = case["args"]
            assert isinstance(args, dict)
            stated |= set(options(args))
    assert stated == {field.alias or name for name, field in MarkAssistOptions.model_fields.items()}
