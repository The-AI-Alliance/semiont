"""What a failure withholds: no part of a credential is said by a failure, by what it is raised from, or by a line logged of it.

An exchange carries credentials: the token a request is made with, and the
token an answer grants. Whatever reads one as HTTP quotes what it could not
read, a header of the request and a line of the answer alike, and whatever
decodes an answer's body shows what it was given. Every request this package
makes is held here to saying neither.

No server that speaks HTTP frames an answer wrongly, so the gateway server
writes what it is scripted to, as it is (`Answer.raw`).

The bus carries a credential too, the token a resource is cloned by, and its
payloads are decoded as an answer's body is. What is said of one that is not
its channel's is held to the same.
"""

import logging
import re
from collections.abc import Awaitable, Callable
from typing import Final, get_args

import httpx
import pytest
from aio import run, soon
from gateway_server import Answer, GatewayServer
from issuer import AGENT, CONFIGURATION, TOKEN, account, issuer_of, says, trusting
from pydantic import JsonValue, ValidationError
from shown import CARRIED, parts_of, printed
from tokens import token

from semiont._lacks import lacks
from semiont.bus import Bus
from semiont.channel import Channel
from semiont.channels import (
    BECKON_HOVER,
    CHANNELS,
    JOB_CHECKPOINT,
    JOB_COMPLETE,
    PANEL_CLOSE,
    YIELD_CLONE_RESOURCE_REQUESTED,
    YIELD_CLONE_TOKEN_GENERATED,
)
from semiont.errors import SemiontError
from semiont.event_bus import EventBus
from semiont.http import AgentToken, HttpTransport, ServiceToken, Timing
from semiont.http._withheld import why_unanswered
from semiont.http.oauth import discover_issuer, issuer_client, refresh_at_issuer
from semiont.identifiers import ResourceId
from semiont.model import WireModel
from semiont.operations import YIELD_CLONE_TOKEN_REQUESTED
from semiont.retry import RetryPolicy
from semiont.testing import FaultyTransport
from semiont.types import YieldCloneTokenRequest
from semiont.watched import Variable, reached

MEDIA: Final = "/api/tokens/media"
RESOURCE: Final = ResourceId("res-1")
BYTES: Final = f"/resources/{RESOURCE}"
QUICK: Final = Timing(reconnect_ms=10, emit_retry=RetryPolicy(attempts=2, initial_delay_ms=1, max_delay_ms=1))

GRANT: Final = says({"access_token": CARRIED, "token": CARRIED}).body
"""An answer that grants a token, whichever request of this package it answers."""

NOT_HTTP: Final = {
    "declared chunked and sent whole": b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n"
    + GRANT
    + b"\r\n",
    "a line that is no header": b"HTTP/1.1 200 OK\r\n" + GRANT + b"\r\n\r\n",
    "a body where the status line belongs": GRANT + b"\r\n\r\n",
}
"""The grant in each framing that is not HTTP. The HTTP library says of each which line it could not read, and quotes the line."""

EVERY: Final = tuple(NOT_HTTP)
# The head of the first is HTTP, so a request that reads an answer's body apart from its head fails there.
CUT_OFF: Final = ("declared chunked and sent whole",)
NEVER_BEGUN: Final = ("a line that is no header", "a body where the status line belongs")

ILL_FORMED: Final = f"{CARRIED}\n"
"""A token as a file gives it, its line end with it: no header's value."""

type Site = Callable[[GatewayServer, Answer], Awaitable[SemiontError]]
"""One place this package makes a request from: the request made of a gateway that answers it as scripted, and the failure it ended in."""
type Saying = Callable[[GatewayServer], str]


async def raised(asking: Awaitable[object]) -> SemiontError:
    """The failure `asking` ends in."""
    with pytest.raises(SemiontError) as failed:
        await soon(asking)
    return failed.value


def unsaid(head: str, kind: str = "RemoteProtocolError") -> str:
    """A failure that names the kind of the HTTP library's error, and says none of its words."""
    return f"{head}: {kind}, its own words withheld"


async def issuer_discovery(gateway: GatewayServer, said: Answer) -> SemiontError:
    gateway.scripted[("GET", CONFIGURATION)] = [said]
    return await raised(discover_issuer(gateway.origin))


async def account_discovery(gateway: GatewayServer, said: Answer) -> SemiontError:
    gateway.scripted[("GET", CONFIGURATION)] = [said]
    return await raised(ServiceToken(account(gateway)).authorization())


async def refresh_grant(gateway: GatewayServer, said: Answer) -> SemiontError:
    gateway.scripted[("POST", TOKEN)] = [said]
    async with issuer_client() as http:
        return await raised(refresh_at_issuer(http, f"{gateway.origin}{TOKEN}", "semiont-cli", "refresh-1"))


async def account_grant(gateway: GatewayServer, said: Answer) -> SemiontError:
    gateway.scripted[("POST", TOKEN)] = [said]
    return await raised(ServiceToken(account(gateway)).authorization())


async def signing_in(gateway: GatewayServer) -> None:
    async with AgentToken(gateway.origin, provider="ollama", model="gemma2:27b", service=ServiceToken(account(gateway))):
        pass


async def agent_exchange(gateway: GatewayServer, said: Answer) -> SemiontError:
    gateway.answers[TOKEN] = {"access_token": token(3600, 0)}
    gateway.scripted[("POST", AGENT)] = [said]
    return await raised(signing_in(gateway))


async def refused_by(origin: str, asking: Callable[[HttpTransport], Awaitable[object]], held: str = "t") -> SemiontError:
    """The failure a request of the gateway at `origin` ends in. Its transport is never opened: only an emit needs the stream."""
    transport = HttpTransport(origin, token=Variable[str | None](held), channels=())
    try:
        return await raised(asking(transport))
    finally:
        await transport.close()


async def media_token(gateway: GatewayServer, said: Answer, held: str = "t") -> SemiontError:
    gateway.scripted[("POST", MEDIA)] = [said]
    return await refused_by(gateway.origin, lambda transport: transport.get_media_token(RESOURCE), held)


async def resource_bytes(gateway: GatewayServer, said: Answer) -> SemiontError:
    gateway.scripted[("GET", BYTES)] = [said]
    return await refused_by(gateway.origin, lambda transport: transport.content.get_binary(RESOURCE))


async def resource_stream(gateway: GatewayServer, said: Answer) -> SemiontError:
    gateway.scripted[("GET", BYTES)] = [said]

    async def reading(transport: HttpTransport) -> None:
        async with await transport.content.get_binary_stream(RESOURCE) as stream:
            _ = [piece async for piece in stream]

    return await refused_by(gateway.origin, reading)


async def emit(gateway: GatewayServer, said: Answer, held: str = "t") -> SemiontError:
    # An emit that got no answer is made again, as often as its budget allows.
    gateway.scripted[("POST", "/bus/emit")] = [said, said]
    async with HttpTransport(gateway.origin, token=Variable[str | None](held), channels=("beckon:focus",), timing=QUICK) as transport:
        return await raised(transport.emit("beckon:focus", {}))


SITES: Final[dict[str, tuple[Site, Saying, tuple[str, ...]]]] = {
    "an issuer's discovery": (issuer_discovery, lambda gateway: unsaid(f"Issuer {issuer_of(gateway)}: discovery was not answered"), EVERY),
    "a service account's discovery": (
        account_discovery,
        lambda gateway: unsaid(f"OIDC discovery for {issuer_of(gateway)} got no answer"),
        EVERY,
    ),
    "a grant": (refresh_grant, lambda _: unsaid("The issuer did not answer"), EVERY),
    # What its own failure is raised from says the rest, and is printed with it.
    "a service account's grant": (
        account_grant,
        lambda gateway: f"Client-credentials grant for semiont-smelter at {issuer_of(gateway)} got no answer",
        EVERY,
    ),
    "an agent's exchange": (agent_exchange, lambda gateway: unsaid(f"{gateway.origin}{AGENT} got no answer"), EVERY),
    "a gateway operation not answered": (media_token, lambda _: unsaid(f"POST {MEDIA} got no answer"), NEVER_BEGUN),
    "a gateway operation's answer": (media_token, lambda _: unsaid(f"POST {MEDIA} ended before its answer did"), CUT_OFF),
    "a resource's bytes": (resource_bytes, lambda _: unsaid(f"GET {BYTES} ended before its bytes did"), CUT_OFF),
    "a resource's bytes as they come": (resource_stream, lambda _: unsaid(f"GET {BYTES} ended before its bytes did"), CUT_OFF),
    "an emit": (emit, lambda _: unsaid("/bus/emit got no answer"), EVERY),
}


def said_by_this_package(caplog: pytest.LogCaptureFixture) -> str:
    """Every line this package logged."""
    return "\n".join(record.getMessage() for record in caplog.records if record.name.startswith("semiont"))


@pytest.mark.parametrize(
    ("site", "saying", "framing"),
    [
        pytest.param(site, saying, framing, id=f"{name}, {framing}")
        for name, (site, saying, framings) in SITES.items()
        for framing in framings
    ],
)
def test_an_answer_that_is_not_http_is_said_by_the_kind_of_error_it_is_and_in_none_of_its_own_words(
    site: Site, saying: Saying, framing: str, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            failure = await site(gateway, Answer(raw=NOT_HTTP[framing]))
            assert parts_of(CARRIED, printed(failure)) == []
            assert failure.message == saying(gateway)
            assert failure.status is None

    with caplog.at_level(logging.DEBUG, logger="semiont"):
        run(scenario())
    assert parts_of(CARRIED, said_by_this_package(caplog)) == []


def test_a_request_whose_token_is_no_header_value_is_said_in_none_of_the_tokens_words(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            trusting(gateway)
            operation = await media_token(gateway, Answer(), ILL_FORMED)
            emitted = await emit(gateway, Answer(), ILL_FORMED)
            # A service account granted such a token asks for its agent's with it.
            gateway.answers[TOKEN] = {"access_token": ILL_FORMED}
            exchanged = await raised(signing_in(gateway))

            assert [failure.message for failure in (operation, emitted, exchanged)] == [
                unsaid(f"POST {MEDIA} got no answer", "LocalProtocolError"),
                unsaid("/bus/emit got no answer", "LocalProtocolError"),
                unsaid(f"{gateway.origin}{AGENT} got no answer", "LocalProtocolError"),
            ]
            for failure in (operation, emitted, exchanged):
                assert parts_of(CARRIED, printed(failure)) == []
                assert failure.status is None
            # None of the three left this process.
            assert [gateway.of("POST", path) for path in (MEDIA, "/bus/emit", AGENT)] == [[], [], []]

    with caplog.at_level(logging.DEBUG, logger="semiont"):
        run(scenario())
    assert parts_of(CARRIED, said_by_this_package(caplog)) == []


@pytest.mark.parametrize(
    ("answer", "lacks"),
    [
        (says({"tokn": CARRIED}), "it has no `token`"),
        (says({"token": [CARRIED]}), "its `token` is malformed"),
        (says([{"token": CARRIED}]), "it is not the JSON object its declared body is"),
        (Answer(body=f"token={CARRIED}".encode()), "it is not the JSON object its declared body is"),
    ],
    ids=["no token", "a token that is none", "not an object", "not JSON"],
)
def test_an_answer_that_is_not_its_declared_body_is_refused_for_what_it_lacks_and_in_none_of_its_own_words(
    answer: Answer, lacks: str
) -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            refused = await media_token(gateway, answer)
            # A media token is a credential whether or not its answer is the one declared: no part of it is said.
            assert parts_of(CARRIED, printed(refused)) == []
            assert refused.message == f"POST {MEDIA} answered what is not its declared body: {lacks}"
            assert (refused.code, refused.status) == ("error", 200)

    run(scenario())


def test_what_an_answer_lacks_is_said_by_the_names_its_body_declares_on_the_way_to_it_as_the_wire_gives_them() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            # A member that is there and lacks one of its own, a member that is not there, and one the wire names as Python does not.
            gateway.scripted[("GET", "/api/status")] = [
                says({"status": "operational", "version": "1.0.0", "features": {"collaboration": CARRIED}, "authenticatedAs": [CARRIED]})
            ]
            refused = await refused_by(gateway.origin, lambda transport: transport.get_status())
            assert parts_of(CARRIED, printed(refused)) == []
            assert refused.message == (
                "GET /api/status answered what is not its declared body: "
                "it has no `features.semanticContent`; it has no `message`; its `authenticatedAs` is malformed"
            )

    run(scenario())


def test_a_gateway_that_cannot_be_reached_is_said_as_the_http_library_says_it() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway:
            origin = gateway.origin
        # Nothing listens there now.
        unreached = await refused_by(origin, lambda transport: transport.get_media_token(RESOURCE))
        # The kind of error, and the library's own words for it: what whoever runs the process needs.
        assert re.fullmatch(rf"POST {MEDIA} got no answer: ConnectError\('.+'\)", unreached.message)
        assert (unreached.code, unreached.status) == ("unavailable", None)

    run(scenario())


# ── What the bus carries ────────────────────────────────────────────────

DESCRIBED: Final[dict[str, JsonValue]] = {"@context": "https://schema.org", "@id": "res-1", "representations": []}
"""A resource's description, but for its name."""


@pytest.mark.parametrize(
    ("channel", "payload", "lacks"),
    [
        (YIELD_CLONE_RESOURCE_REQUESTED, {"token": [CARRIED]}, "its `token` is malformed"),
        (YIELD_CLONE_TOKEN_GENERATED, {"token": CARRIED, "resource": DESCRIBED}, "it has no `response`"),
        (
            YIELD_CLONE_TOKEN_GENERATED,
            {"response": {"token": [CARRIED], "resource": DESCRIBED}},
            "its `response.token` is malformed; it has no `response.expiresAt`; it has no `response.resource.name`",
        ),
        (BECKON_HOVER, {"annotation_id": [CARRIED]}, "its `annotationId` is malformed"),
        (PANEL_CLOSE, {CARRIED[:12]: CARRIED}, "it has a member that channel's payload has not"),
        (
            JOB_CHECKPOINT,
            {"jobId": "job-1", "completedUnits": [[CARRIED]], "unitCursors": {CARRIED: {"next": CARRIED}}},
            "its `completedUnits` is malformed; its `unitCursors` is malformed",
        ),
        (JOB_COMPLETE, {"jobType": "mark", "result": [CARRIED]}, "it has no `resourceId`; it has no `jobId`; its `result` is malformed"),
        (JOB_COMPLETE, {"jobType": CARRIED}, "it is not the JSON object that channel's payload is"),
        (JOB_COMPLETE, {"result": {"token": CARRIED}}, "it is not the JSON object that channel's payload is"),
    ],
    ids=[
        "a member that is malformed",
        "no member a reply has",
        "members of a member",
        "a member by the name Python gives it",
        "a member the channel's payload has not",
        "a name and a place that are the payload's own",
        "one of several shapes, named",
        "one of several shapes, named as none of them",
        "one of several shapes, not named",
    ],
)
def test_a_payload_that_is_not_its_channel_s_is_said_by_what_it_lacks_and_in_none_of_its_own_words[P: WireModel](
    channel: Channel[P], payload: dict[str, JsonValue], lacks: str, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        bus = EventBus()
        read = bus.frames(channel)
        bus.emit(channel.name, payload)
        bus.destroy()
        assert [delivered async for delivered in read] == []

    with caplog.at_level(logging.WARNING, logger="semiont.bus"):
        run(scenario())
    assert [record.getMessage() for record in caplog.records] == [f"a payload on {channel.name} is not that channel's: {lacks}"]
    assert parts_of(CARRIED, said_by_this_package(caplog)) == []


def test_a_result_that_is_not_its_operation_s_is_refused_for_what_it_lacks_and_in_none_of_its_own_words() -> None:
    async def scenario() -> None:
        transport = FaultyTransport()
        # The token a resource is cloned by is a credential, whether or not the answer that carries it is the one declared.
        transport.queue_reply("yield:clone-token-requested", [{"token": CARRIED, "expiresAt": "2026-10-11T00:00:00.000Z"}])
        refused = await raised(Bus(transport).request(YIELD_CLONE_TOKEN_REQUESTED, YieldCloneTokenRequest(resource_id=RESOURCE)))
        assert parts_of(CARRIED, printed(refused)) == []
        assert refused.message == "a payload on yield:clone-token-generated is not that channel's: it has no `response.resource`"
        assert (refused.code, refused.status) == ("error", None)

    run(scenario())


def test_what_a_stream_carries_that_is_no_frame_is_said_by_what_it_lacks_and_in_none_of_its_own_words(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def scenario() -> None:
        async with (
            GatewayServer() as gateway,
            HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=("beckon:focus",), timing=QUICK) as transport,
        ):
            await soon(reached(transport.state, lambda state: state == "open"))
            frames = transport.frames("beckon:focus")
            gateway.send("e-1", {"channel": "beckon:focus", "payload": {"token": CARRIED}, "scope": 5})
            gateway.send("e-2", {"payload": {"token": CARRIED}})
            gateway.write(f'id: e-3\nevent: bus-event\ndata: {{"token": "{CARRIED}" not json\n\n')
            gateway.send("e-4", {"channel": "beckon:focus", "payload": {}})
            # The stream is read in order: what came before this frame has been read.
            assert (await soon(anext(frames))).payload == {}

    with caplog.at_level(logging.WARNING, logger="semiont.http"):
        run(scenario())
    assert [record.getMessage() for record in caplog.records] == [
        "the stream carried what is not a frame (id e-1): its `scope` is malformed",
        "the stream carried what is not a frame (id e-2): it has no `channel`",
        "the stream carried what is not a frame (id e-3): it is not the JSON object a frame is",
    ]
    assert parts_of(CARRIED, said_by_this_package(caplog)) == []


def test_every_channel_that_carries_one_of_several_shapes_says_what_a_payload_lacks_of_the_shape_it_names() -> None:
    several = {name: channel for name, channel in CHANNELS.items() if len(channel.members) > 1}
    # Each tells its shapes apart by `jobType`, and the decoder says which one a payload named before it says where the payload is
    # wrong. A channel that tells its shapes apart another way fails here until what is said of its payloads has been read.
    assert sorted(several) == ["job:complete", "job:create", "job:queued"]
    for channel in several.values():
        for shape in channel.members:
            (named,) = get_args(shape.model_fields["job_type"].annotation)
            with pytest.raises(ValidationError) as refused:
                channel.decode({"jobType": named})
            required = [field.alias or name for name, field in shape.model_fields.items() if field.is_required() and name != "job_type"]
            assert required != []
            said = lacks(channel.members, refused.value, "that channel's payload")
            assert said == "; ".join(f"it has no `{member}`" for member in required)


def kinds(of: type[httpx.HTTPError]) -> set[type[httpx.HTTPError]]:
    """A kind of error the HTTP library has, and every kind of it."""
    return {of}.union(*(kinds(kind) for kind in of.__subclasses__()))


def an_error(kind: type[httpx.HTTPError]) -> httpx.HTTPError:
    """An error of `kind` whose words are a credential."""
    if issubclass(kind, httpx.HTTPStatusError):
        request = httpx.Request("GET", "https://kb.example.org")
        return kind(CARRIED, request=request, response=httpx.Response(500, request=request))
    return kind(CARRIED)


# The connection's: reaching the far end, the socket and TLS beneath the exchange, and time.
TOLD: Final[set[type[httpx.HTTPError]]] = {
    httpx.NetworkError,
    httpx.ConnectError,
    httpx.ReadError,
    httpx.WriteError,
    httpx.CloseError,
    httpx.TimeoutException,
    httpx.ConnectTimeout,
    httpx.ReadTimeout,
    httpx.WriteTimeout,
    httpx.PoolTimeout,
}
WITHHELD: Final[set[type[httpx.HTTPError]]] = {
    httpx.HTTPError,
    httpx.RequestError,
    httpx.TransportError,
    httpx.ProtocolError,
    httpx.LocalProtocolError,
    httpx.RemoteProtocolError,
    httpx.ProxyError,
    httpx.UnsupportedProtocol,
    httpx.DecodingError,
    httpx.TooManyRedirects,
    httpx.HTTPStatusError,
}


def test_every_kind_of_error_the_http_library_has_is_one_whose_words_are_told_or_one_whose_words_are_withheld() -> None:
    # A kind the library gains is neither, and fails here until someone has read what it can say.
    assert kinds(httpx.HTTPError) == TOLD | WITHHELD
    assert TOLD.isdisjoint(WITHHELD)
    for kind in TOLD:
        error = an_error(kind)
        assert why_unanswered(error) == repr(error)
    for kind in WITHHELD:
        why = why_unanswered(an_error(kind))
        assert why == f"{kind.__name__}, its own words withheld"
        assert parts_of(CARRIED, why) == []
    # A deadline of this package's own passing is the connection's too.
    assert why_unanswered(TimeoutError()) == "TimeoutError()"
