"""Content and the gateway's own operations over HTTP, for what the conformance corpus cannot script.

The corpus holds them to the protocol against a real gateway. Here are the
parts it has no way to cause on cue: a body that stops coming, an answer that
is not the one declared, a request tried a second time, a deadline, and what
an upload does when it is read twice or abandoned.
"""

import asyncio
import dataclasses

import pytest
from aio import run, soon
from gateway_server import NOT_FOUND, Answer, GatewayServer
from pydantic import JsonValue, TypeAdapter

from semiont.errors import SemiontError, TransportError
from semiont.http import HttpTransport, Timing
from semiont.http.content import form_of
from semiont.identifiers import AnnotationId, JobId, ResourceId
from semiont.transport import PutBinaryRequest, UploadProgress
from semiont.types import AgentSoftware, ResourceUpload
from semiont.watched import Variable

EVERY_BYTE = bytes(range(256)) * 600
QUICK = Timing(reconnect_ms=10, http_request_ms=150)
RESOURCE = ResourceId("res-1")
_JSON = TypeAdapter[JsonValue](JsonValue)


def transport_to(gateway: GatewayServer, token: str | None = "t") -> HttpTransport:
    return HttpTransport(gateway.origin, token=Variable[str | None](token), channels=("beckon:focus",), timing=QUICK)


def test_an_upload_names_every_field_the_form_has_and_no_other() -> None:
    # The upload a caller writes and the form the spec states are two shapes of one thing.
    assert {field.name for field in dataclasses.fields(PutBinaryRequest)} == set(ResourceUpload.model_fields)


def test_an_upload_carries_its_bytes_unchanged_and_each_field_under_its_own_name() -> None:
    request = PutBinaryRequest(
        name='A "quoted"\r\nname',
        file=EVERY_BYTE,
        format="image/png",
        storage_uri="file://uploads/every-byte.png",
        entity_types=["Person", "Place"],
        language="en",
        source_resource_id=ResourceId("res-source"),
        source_annotation_id=AnnotationId("ann-source"),
        generation_prompt="a prompt",
        generator=AgentSoftware.model_validate({"@type": "Software", "name": "a model"}),
        job_id=JobId("job-1"),
        is_draft=True,
        archive_original=False,
    )

    async def scenario() -> tuple[str, dict[str, tuple[bytes, dict[str, str]]], str, list[UploadProgress]]:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            upload = transport.content.put_binary(request)
            reports = [progress async for progress in upload]
            created = await upload
            sent = gateway.of("POST", "/resources")[0]
            return created.resource_id, sent.form(), sent.headers["content-length"], reports

    created, form, stated_length, reports = run(scenario())
    assert created == "res-uploaded-1"
    data, file_headers = form.pop("file")
    assert data == EVERY_BYTE
    assert file_headers["content-type"] == "image/png"
    assert 'filename="A %22quoted%22%0D%0Aname"' in file_headers["content-disposition"]
    assert {name: value.decode() for name, (value, _) in form.items()} == {
        "name": 'A "quoted"\r\nname',
        "format": "image/png",
        "storageUri": "file://uploads/every-byte.png",
        "language": "en",
        "entityTypes": '["Person","Place"]',
        "sourceAnnotationId": "ann-source",
        "sourceResourceId": "res-source",
        "generationPrompt": "a prompt",
        "generator": '{"@type":"Software","name":"a model"}',
        "jobId": "job-1",
        "isDraft": "true",
        "archiveOriginal": "false",
    }
    # Its progress: one total, the size of the whole request; never less than it last said; and all of it at the end.
    assert len(reports) > 2
    assert {progress.total_bytes for progress in reports} == {int(stated_length)}
    assert [progress.bytes_uploaded for progress in reports] == sorted(progress.bytes_uploaded for progress in reports)
    assert reports[-1].bytes_uploaded == reports[-1].total_bytes


def test_a_field_with_nothing_to_say_is_left_out_of_the_form() -> None:
    said = form_of(PutBinaryRequest(name="n", file=b"", format="text/plain", storage_uri="file://n", language="", generation_prompt=""))
    assert said.model_dump(exclude_none=True) == {"name": "n", "file": b"", "format": "text/plain", "storageUri": "file://n"}


def test_an_upload_is_awaited_once_and_its_progress_read_once() -> None:
    async def scenario() -> None:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            upload = transport.content.put_binary(PutBinaryRequest(name="n", file=b"abc", format="text/plain", storage_uri="file://n"))
            await upload
            with pytest.raises(RuntimeError, match="awaited once"):
                await upload
            assert [progress async for progress in upload] != []
            with pytest.raises(RuntimeError, match="read once"):
                aiter(upload)
            assert len(gateway.of("POST", "/resources")) == 1

    run(scenario())


def test_an_upload_its_caller_abandons_closes_its_connection_reports_nothing_and_is_not_sent_again() -> None:
    async def scenario() -> tuple[int, list[SemiontError]]:
        async with GatewayServer() as gateway:
            gateway.scripted[("POST", "/resources")] = [Answer(hold=True)]
            async with transport_to(gateway) as transport:
                failures = transport.failures()
                upload = transport.content.put_binary(
                    PutBinaryRequest(name="n", file=EVERY_BYTE, format="image/png", storage_uri="file://n")
                )

                async def follow() -> None:
                    async for _ in upload:
                        pass

                following = asyncio.ensure_future(follow())
                await soon(gateway.arrived("POST", "/resources"))
                following.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await following
                await soon(gateway.closed_by_client.wait())
                await asyncio.sleep(0.05)
            return len(gateway.of("POST", "/resources")), [error async for error in failures]

    assert run(scenario()) == (1, [])


def test_a_transport_closed_under_an_upload_and_a_read_ends_each_as_a_request_that_got_no_answer() -> None:
    async def scenario() -> tuple[str, str, str]:
        async with GatewayServer() as gateway:
            gateway.scripted[("POST", "/resources")] = [Answer(hold=True)]
            gateway.scripted[("GET", "/api/health")] = [Answer(hold=True)]
            transport = HttpTransport(gateway.origin, token=Variable[str | None]("t"), channels=("beckon:focus",))
            async with transport:
                upload = transport.content.put_binary(PutBinaryRequest(name="n", file=b"abc", format="text/plain", storage_uri="file://n"))

                async def created() -> str:
                    return (await upload).resource_id

                uploading = asyncio.ensure_future(created())
                asking = asyncio.ensure_future(transport.health_check())
                await soon(gateway.arrived("POST", "/resources"))
                await soon(gateway.arrived("GET", "/api/health"))
            # Closed: nothing of the transport's is left running, and each caller has its answer.
            with pytest.raises(TransportError) as uploaded:
                await soon(uploading)
            with pytest.raises(TransportError) as asked:
                await soon(asking)
            # And nothing is sent of a closed one.
            with pytest.raises(TransportError) as after:
                await soon(transport.health_check())
            assert len(gateway.of("GET", "/api/health")) == 1
            return uploaded.value.code, asked.value.code, after.value.code

    assert run(scenario()) == ("unavailable", "unavailable", "error")


def test_a_read_gives_the_bytes_unchanged_whole_or_as_they_arrive_and_one_that_is_not_there_fails_as_not_found() -> None:
    async def scenario() -> tuple[bytes, str, bytes, str, TransportError, list[SemiontError]]:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            gateway.stored[RESOURCE] = ("image/png", EVERY_BYTE)
            failures = transport.failures()
            whole = await transport.content.get_binary(RESOURCE)
            async with await transport.content.get_binary_stream(RESOURCE) as stream:
                arrived = b"".join([piece async for piece in stream])
            with pytest.raises(TransportError) as missing:
                await transport.content.get_binary(ResourceId("res-2"))
            await transport.close()
            return whole.data, whole.content_type, arrived, stream.content_type, missing.value, [error async for error in failures]

    whole, whole_type, arrived, arrived_type, missing, reported = run(scenario())
    assert whole == arrived == EVERY_BYTE
    assert whole_type == arrived_type == "image/png"
    assert (missing.code, missing.status, missing.message) == ("not-found", 404, "The gateway has no such thing")
    assert reported == [missing]


def test_a_read_whose_bytes_stop_coming_fails_as_unavailable_and_one_left_early_ends() -> None:
    async def scenario() -> tuple[list[str], int]:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            gateway.scripted[("GET", "/resources/res-1")] = [Answer(body=b"only this much", promise=10_000) for _ in range(2)]
            gateway.stored[RESOURCE] = ("text/plain", EVERY_BYTE)
            with pytest.raises(TransportError) as whole:
                await transport.content.get_binary(RESOURCE)
            async with await transport.content.get_binary_stream(RESOURCE) as stream:
                with pytest.raises(TransportError) as arriving:
                    _ = [piece async for piece in stream]
            async with await transport.content.get_binary_stream(RESOURCE) as left:
                first = await anext(aiter(left))
            return [whole.value.code, arriving.value.code], len(first)

    codes, first = run(scenario())
    assert codes == ["unavailable", "unavailable"]
    assert first > 0


def test_a_description_is_what_the_gateway_answers_and_an_answer_that_is_not_the_one_declared_is_a_failure() -> None:
    described: dict[str, JsonValue] = {
        "resource": {"@context": "https://schema.org/", "@id": "res-1", "name": "Described", "representations": []},
        "annotations": [],
        "entityReferences": [],
    }

    async def scenario() -> tuple[JsonValue, TransportError]:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            gateway.described[RESOURCE] = described
            graph = await transport.content.get_resource_graph(RESOURCE)
            gateway.scripted[("GET", "/resources/res-1/jsonld")] = [Answer(body=b'{"resource": "not a description"}')]
            with pytest.raises(TransportError) as undeclared:
                await transport.content.get_resource_graph(RESOURCE)
            return graph.model_dump(mode="json", exclude_unset=True), undeclared.value

    graph, undeclared = run(scenario())
    assert graph == described
    assert (undeclared.code, undeclared.status) == ("error", 200)


def test_each_gateway_operation_is_one_request_to_its_own_path_and_carries_the_token_where_it_needs_one() -> None:
    answers: dict[str, dict[str, JsonValue]] = {
        "/api/health": {"status": "ok", "message": "serving", "version": "0.0.0", "timestamp": "2026-10-06T05:04:06.111Z"},
        "/api/status": {
            "status": "ok",
            "version": "0.0.0",
            "features": {"semanticContent": "on", "collaboration": "on"},
            "message": "serving",
            "authenticatedAs": "did:web:example.org:users:a",
        },
        "/api/users/me": {
            "did": "did:web:example.org:users:a",
            "email": "a@example.org",
            "name": None,
            "image": None,
            "domain": "example.org",
        },
        "/.well-known/oauth-protected-resource": {
            "resource": "https://kb.example.org",
            "authorization_servers": ["https://issuer.example.org"],
            "bearer_methods_supported": ["header"],
        },
        "/api/tokens/media": {"token": "a-media-token"},
    }

    async def scenario() -> tuple[list[JsonValue], list[tuple[str, str, str | None]], JsonValue]:
        async with GatewayServer() as gateway, transport_to(gateway, token="the-token") as transport:
            gateway.answers = answers
            answered: list[JsonValue] = [
                (await transport.health_check()).model_dump(mode="json", exclude_unset=True),
                (await transport.get_status()).model_dump(mode="json", exclude_unset=True),
                (await transport.get_current_user()).model_dump(mode="json", exclude_unset=True),
                (await transport.get_protected_resource_metadata()).model_dump(mode="json", exclude_unset=True),
                (await transport.get_media_token(RESOURCE)).model_dump(mode="json", exclude_unset=True),
            ]
            asked = [(a.method, a.path, a.headers.get("authorization")) for a in gateway.asked if a.path != "/bus/subscribe"]
            return answered, asked, _JSON.validate_json(gateway.of("POST", "/api/tokens/media")[0].body)

    answered, asked, media_body = run(scenario())
    # What the gateway answered is what the caller is given: a null stays a null, and a time is the text it came as.
    assert answered == list(answers.values())
    assert asked == [
        ("GET", "/api/health", "Bearer the-token"),
        ("GET", "/api/status", "Bearer the-token"),
        ("GET", "/api/users/me", "Bearer the-token"),
        ("GET", "/.well-known/oauth-protected-resource", None),
        ("POST", "/api/tokens/media", "Bearer the-token"),
    ]
    assert media_body == {"resourceId": "res-1"}


def test_a_request_safe_to_repeat_is_made_a_second_time_and_one_that_is_not_is_not() -> None:
    not_now = Answer(status=503, body=b'{"error":"The gateway is starting"}')

    async def scenario() -> tuple[str, int, list[object], int, list[object], int, list[object], int]:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            gateway.answers = {
                "/api/health": {"status": "ok", "message": "m", "version": "v", "timestamp": "t"},
                "/api/tokens/media": {"token": "m"},
            }
            # A status that promises recovery, on a read: asked again, and answered.
            gateway.scripted[("GET", "/api/health")] = [not_now]
            recovered = (await transport.health_check()).status
            asked_health = len(gateway.of("GET", "/api/health"))
            # The same status twice: the second is the answer.
            gateway.scripted[("GET", "/api/health")] = [not_now, not_now]
            with pytest.raises(TransportError) as twice:
                await transport.health_check()
            # On a request that may already have had its effect: not asked again.
            gateway.scripted[("POST", "/api/tokens/media")] = [not_now]
            with pytest.raises(TransportError) as posted:
                await transport.get_media_token(RESOURCE)
            # A refusal that will be made again: not asked again.
            gateway.scripted[("GET", "/api/users/me")] = [NOT_FOUND]
            with pytest.raises(TransportError) as refused:
                await transport.get_current_user()
            return (
                recovered,
                asked_health,
                [twice.value.code, twice.value.status, twice.value.message],
                len(gateway.of("GET", "/api/health")),
                [posted.value.code, posted.value.status],
                len(gateway.of("POST", "/api/tokens/media")),
                [refused.value.code, refused.value.status],
                len(gateway.of("GET", "/api/users/me")),
            )

    assert run(scenario()) == (
        "ok",
        2,
        ["unavailable", 503, "The gateway is starting"],
        4,
        ["unavailable", 503],
        1,
        ["not-found", 404],
        1,
    )


def test_a_request_never_answered_fails_as_unavailable_at_its_deadline_and_is_not_made_again() -> None:
    async def scenario() -> tuple[str, int | None, int, str, int, list[SemiontError]]:
        async with GatewayServer() as gateway, transport_to(gateway) as transport:
            failures = transport.failures()
            gateway.scripted[("GET", "/api/health")] = [Answer(hold=True)]
            with pytest.raises(TransportError) as late:
                await soon(transport.health_check())
            # One the gateway hangs up on is made a second time, since asking a read again changes nothing.
            gateway.scripted[("GET", "/api/status")] = [Answer(hang_up=True), Answer(hang_up=True)]
            with pytest.raises(TransportError) as unanswered:
                await soon(transport.get_status())
            asked = len(gateway.of("GET", "/api/health")), len(gateway.of("GET", "/api/status"))
            await transport.close()
            return late.value.code, late.value.status, asked[0], unanswered.value.code, asked[1], [error async for error in failures]

    code, status, asked_once, unanswered, asked_twice, reported = run(scenario())
    assert (code, status, asked_once) == ("unavailable", None, 1)
    assert (unanswered, asked_twice) == ("unavailable", 2)
    assert [error.code for error in reported] == ["unavailable", "unavailable"]
