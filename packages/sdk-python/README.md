# semiont

The Python SDK for [Semiont][semiont], an open platform for building trusted
AI knowledge bases: a shared workspace where humans and AI agents annotate,
connect and govern a corpus of documents.

This package is the client. With it a program reads and writes one knowledge
base: it adds resources, annotates and links them, searches them, gathers
context for a model, and hears what the other participants do as they do it.
A person's application and an AI agent use the same client. The SDK does not
tell them apart.

It has the same namespaces, methods and live queries as the
[TypeScript SDK][sdk-typescript] and the [Rust SDK][sdk-rust], and is held to
the same [conformance suite][conformance]. New to Semiont? The
[Introduction][introduction] explains the domain and the ideas the API falls
out of. Its code is TypeScript, and the ideas are this package's too.

## Install

```bash
pip install semiont
```

It requires Python 3.12 or later, and runs on asyncio. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`): a wrong id, a wrong payload for a channel and an unhandled code
or state are errors a type checker reports.

One package holds all of it: the client, the transport that carries it over
HTTP to a knowledge base's gateway, signing in, and the doubles a test is
built on. Its dependencies are `httpx`, `pydantic` and `opentelemetry-api`.

A client speaks to a running knowledge base. The [Quick Start][quick-start]
sets one up on your own machine.

## The client

A client is the eleven namespaces over one transport: `frame`, `browse`,
`mark`, `bind`, `gather`, `match`, `yield_` and `beckon`, one per
[flow of the protocol][protocol], and `job`, `auth` and `system` beside them.
`yield` is Python's own word, so its namespace is `yield_`. Each method is a
row of [`specs/src/client/surface.json`][surface], the table every Semiont SDK
is held to. `HttpTransport` is the transport this package ships: it reaches a
knowledge base's gateway, and sends the token it is given.

```python
from semiont.client import SemiontClient
from semiont.http import HttpTransport
from semiont.identifiers import AnnotationId, ResourceId
from semiont.namespaces.follow import JobAttemptFailed, JobCompleted, JobProgressed
from semiont.namespaces.mark import MarkAssistOptions
from semiont.transport import Transport
from semiont.watched import Variable


async def annotate(client: SemiontClient[Transport], resource: ResourceId, annotation: AnnotationId) -> None:
    described = await client.browse.resource(resource).fresh()  # a query, read once
    text = await client.browse.resource_content(resource)  # asked once, answered once
    print(described.name, len(text))

    async for event in client.mark.assist(resource, "highlighting", MarkAssistOptions()):  # a job, followed
        match event:
            case JobProgressed(data=progress):
                print(progress.percentage)
            case JobAttemptFailed(data=setback):
                print("trying again after:", setback.error)
            case JobCompleted(data=done):
                print(done.result)

    reached = await client.beckon.attention(resource, annotation)  # a drive: how many the gateway reached
    client.browse.click(annotation)  # a signal: this viewer's own, never sent
    print(reached)


async def over_http(origin: str, token: str, resource: ResourceId, annotation: AnnotationId) -> None:
    async with (
        HttpTransport(origin, token=Variable[str | None](token)) as transport,
        SemiontClient(transport, transport.content, transport) as client,
    ):
        await annotate(client, resource, annotation)
```

Every method returns one of seven shapes, and the table says which:

| Shape | In Python | |
|---|---|---|
| asked once, answered once | `async def` | a failure is raised |
| a long-running operation | `Running[T]` | awaited for its final value, or read with `async for` for every report and then the final value; one or the other, once |
| an upload | `Upload` | awaited for the resource it created, read for its progress |
| a query | `Cached[T]` | building it sends nothing; `await query.fresh()` reads it once, and held with `async with` it is watched |
| a signal | `def`, returning nothing | published on the client's own bus, or sent and not awaited |
| a drive | `async def` giving `int \| None` | how many participants the gateway reached, or nothing when it kept no count |
| a channel's events | `Typed[P]` | `async for`, each event's payload decoded |

- **A followed job** (`mark.assist`, `yield_.from_context`) reports its
  progress and ends with its completion. A job that says nothing is asked for
  its status, so a completion the stream did not carry is still heard. It ends
  as a `JobError` when the job failed for good, was cancelled, or (a
  generation) said nothing for longer than its length allows.
- **`client.bus`** is the client's own bus: every frame its transport
  delivered, and every signal its own parts gave each other.
  **`client.wire`** is the bus over the transport, typed by channel.
- **A client is held with `async with`**: inside, it listens for what keeps
  its queries true, and it ends what it started on the way out. It does not
  close its transport: whoever opened that closes it, after the client. A
  session (`session_from_kept`) holds one as `session.client`.
- **A client is generic in its transport.** Code that takes a
  `SemiontClient[Transport]` runs over HTTP and over a test's doubles alike.
- **What it sends unasked is the table's**: a list's first hundred, a
  search's ten candidates, a context's two thousand characters. An option
  given as `None` is an option not given, and is not sent.

Why the shapes are these seven, in every SDK, is
[the reactive model][reactive-model].

## Signing in

A transport sends the token it is given. Where the token comes from is one of
three things, and each keeps it renewed: half its lifetime before it expires,
at most five minutes before, and at once when the gateway refuses it.

**An agent** is a service account's token exchanged at the gateway for the
token of the agent `(provider, model)`. It is what a service holds: a
transport, its agent's token, and the channels it awaits replies on.

```python
from semiont.bus import reply_channels_for
from semiont.http import AgentToken, Credential, HttpTransport, ServiceToken
from semiont.operations import JOB_CLAIM
from semiont.watched import reached


async def work(gateway: str, issuer: str, secret: str) -> None:
    service = ServiceToken(Credential(issuer=issuer, client_id="semiont-smelter", client_secret=secret))
    async with (
        AgentToken(gateway, provider="ollama", model="gemma2:27b", service=service) as agent,
        HttpTransport(gateway, token=agent.token, refresher=agent.refresh, channels=reply_channels_for(JOB_CLAIM)) as transport,
    ):
        print(await reached(transport.state, lambda state: state == "open"))  # its stream is open, as the agent
```

**A person** is signed in at the issuer the knowledge base trusts, and the
sign-in is kept. [`semiont login`][launcher] keeps one for each stack, and a
session here is built over it; a script on a machine with no launcher makes
its own by the device grant, which shows a code to approve in any browser. No
password passes through this process.

```python
from pathlib import Path

from semiont.http import DeviceCode, session_from_kept, sign_in_device
from semiont.sign_in_store import FILE_NAME, SignInStore, state_dir, this_system


def show(code: DeviceCode) -> None:
    print(f"Open {code.verification_uri} and enter {code.user_code}")


async def as_me(gateway: str, home: str) -> None:
    directory = state_dir(this_system(), home=home, xdg_state_home=None, local_app_data=None)
    if directory is None:
        return
    kept = SignInStore(Path(directory) / FILE_NAME).entry("local")
    if await kept.held() is None:
        await sign_in_device(gateway, kept, show)
    async with session_from_kept(gateway, kb_id="local", kept=kept) as session:
        print(session.user.value, (await session.client.system.status()).version)
```

- **An agent whose renewal fails keeps the token it has** and tries again: a
  process holding a token that still works does not stop over one bad round
  trip. Signing in is the one step that raises.
- **A person's session ends once, and says why.** A token the issuer will not
  renew ends it as `expired`, and a token the issuer has just issued and the
  gateway refuses ends it as `refused` (`on_auth_failed`). The sign-in is
  then forgotten, so a dead credential is never sent again. What a session
  does at its start and when it is refused is
  [`specs/src/session/cases.json`][session-cases], row for row.
- **A renewal spends its refresh token once.** Renewals asked for together are
  one request of the issuer, a renewal the issuer did not refuse is tried
  again inside a bounded budget, and one under way runs to its end whoever
  stops waiting for it.
- **The store is the launcher's** ([`specs/src/sign-in-store`][sign-in-store]):
  the same file and the same lock, on macOS, Linux and Windows. A sign-in made
  here serves the launcher's verbs, and one it renewed serves this session.
  `MemorySignIn` keeps one for the life of the process instead, and
  `sign_out` revokes one at its issuer and forgets it.
- **Nothing here reads the environment.** An application reads its own
  (`HOME`, a secret, an address) and says what it found.

## Live queries

A query is one of ten reads
([`specs/src/client/refresh.json`][refresh] names them) that answer from the
client's cache. Read once, it asks the knowledge base now. Held with
`async with`, it is watched: its state now, and each state after it, until
the client closes.

```python
from typing import assert_never

from semiont.cache import Failed, Pending, Ready
from semiont.client import SemiontClient
from semiont.identifiers import ResourceId
from semiont.transport import Transport


async def watch(client: SemiontClient[Transport], resource: ResourceId) -> None:
    async with client.browse.annotations(resource) as live:  # holds the resource's scope
        async for state in live:
            match state:
                case Pending():
                    print("asking")
                case Ready(value=annotations):
                    print(len(annotations), "annotations")
                case Failed(error=error):  # a state, not a raise: the query lives on
                    print("failed:", error.code)
                case _:
                    assert_never(state)
```

- **A state is one of three**, and a `match` that leaves one out does not
  type-check. `Failed` is the state of a query with no value whose request
  failed and failed again. It is not the end: the next watcher, an event or
  `query.invalidate()` asks again, and every watcher is shown what comes.
- **Watching is what asks.** The first watcher of a query starts its request,
  and watchers that arrive together share it. A later one is given what is
  held. A request that fails is made once more; a query that has a value
  keeps showing it whatever its refetches do.
- **A watched query stays true.** While a query of one resource is held, the
  client holds that resource's scope, so its events reach the client; and each
  event asks again for exactly the queries the refresh table gives it, writes
  the value an event carries, or ends an annotation that is gone. What events
  ask of one query inside a second is one request. A stream that dropped and
  returned asks again for what its events could not replay.
- **A read** (`await query.fresh()`) asks now, raises the failure it meets,
  and gives every watcher of the query its answer.
- **A watcher that falls behind** is given the latest state, not each one it
  missed: a state is what is true now.
- **A query is watched inside its client's `async with`**, which is what
  listens for the events. After the client closes, a watcher is given
  nothing and a read is refused as `bus.closed`.
- **A client can keep what its small queries hold**
  (`SemiontClient(..., persistence=CachePersistence(storage=..., key_prefix=...))`),
  in a `semiont.storage.SessionStorage` the application supplies: a
  resource's description, its annotations, one annotation, the entity types,
  the tag schemas. The next client over the same storage shows them at once
  and asks for each anew the first time it is watched.
  `session_from_kept(..., storage=...)` does this for a session, and keeps the
  stream's place in each resource's scope with it (`semiont.resume`), so the
  next session is sent what was recorded since.

The behaviours every SDK's live queries are held to are numbered in
[the cache's semantics][cache-semantics].

## Testing what is built on it

`semiont.testing` gives a real client over doubles. Its namespaces, its cache
and its deadlines are the client's own; only what it speaks through is
scripted. A test says what the knowledge base answers, runs the code under
test, and reads what that code asked.

```python
from semiont.client import SemiontClient
from semiont.identifiers import ResourceId
from semiont.testing import create_test_client
from semiont.transport import Transport


async def title_of(client: SemiontClient[Transport], resource: ResourceId) -> str:
    return (await client.browse.resource(resource).fresh()).name.title()


async def a_title_is_its_resources_name_in_title_case() -> None:
    made = create_test_client()
    made.transport.queue_reply(
        "browse:resource-requested",
        [
            {
                "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "a page of notes", "representations": []},
                "annotations": [],
                "entityReferences": [],
            }
        ],
    )

    async with made.client as client:
        assert await title_of(client, ResourceId("res-1")) == "A Page Of Notes"

    # What the code under test asked of the knowledge base, as it was sent.
    assert [(asked.channel, asked.payload) for asked in made.transport.request_log] == [
        ("browse:resource-requested", {"resourceId": "res-1"})
    ]
    await made.transport.close()
```

- **`FaultyTransport`** is a transport with no wire. `queue_reply` says what
  the gateway answers the next requests of an operation with, and
  `refuse_when` has it answer with a failure. A schedule of `Deliver`,
  `DropReply`, `Delay`, `DuplicateReply` and `RejectEmit` says what the wire
  does to each request in turn, so a lost reply and the retry after it can be
  scripted. `request_log` and `emitted` are what was sent; `deliver` carries a
  frame in as the bus would; `set_state` drops the stream and brings it back.
- **`InMemoryContent`** keeps what is uploaded and what a test seeds, and
  **`StubGateway`** answers the gateway's own operations as a test scripted
  them. Each records the calls made of it.
- **A double refuses what nobody scripted, by name.** A request with no
  answer scripted fails naming its operation, and a read of content nobody
  stored fails naming the resource. None answers with a value of its own
  making, so a test that forgot to say something fails where it forgot.
- **`create_test_client`** takes the doubles a test built, or makes ones
  nothing is scripted on, and the client's own timing and persistence.

## The bus

Under the namespaces is the bus, and a program can speak on it directly. A
transport is held with `async with`. Its stream opens inside, once there is
a token, and everything it started has ended on the way out.

```python
from semiont.bus import Bus
from semiont.channels import MARK_ADDED
from semiont.errors import BusRequestError
from semiont.http import HttpTransport
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_RESOURCE_REQUESTED
from semiont.types import BrowseResourceRequest
from semiont.watched import Variable


async def read(origin: str, token: str, resource: ResourceId) -> None:
    async with HttpTransport(origin, token=Variable[str | None](token)) as transport:
        bus = Bus(transport)
        try:
            reply = await bus.request(BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resource_id=resource))
        except BusRequestError as error:
            print(error.code)  # "bus.not-found", "bus.timeout", …: a closed vocabulary
            return
        print(reply.response.resource.name)

        # Frames arrive on a resource's channels while its scope is held.
        with transport.subscribe_to_resource(resource):
            async with bus.frames(MARK_ADDED) as added:
                async for frame in added:
                    print(frame.scope, frame.payload.type)
```

- **The bus is typed by channel.** A channel is a constant that carries its
  payload's type: a request is refused another operation's payload, its reply
  is that operation's result, and a frame's payload is its channel's. By
  name, with JSON objects, it is `semiont.bus.request` and the transport's
  own `emit` and `frames`.
- **A request** waits for the stream to be open before it is sent, is answered
  once, and is abandoned by cancelling the task that awaits it.
- **Frames** are a sequence: each reader is given every one, in order, however
  far behind it falls.
- **The connection's state** (`transport.state`) is a value: what it is now,
  and each thing it becomes. A dropped stream is a state, never an error, and
  opens again by itself.
- **Failures** are `SemiontError`s under the codes of
  [`specs/src/errors/codes.json`][codes]. What a server refused is also on
  `transport.failures()`.
- **The token** is a value the transport watches: when it changes, the next
  request carries the new one. A stream the gateway refused as unauthorized
  asks its `refresher` for another token, once per outage, and with none
  waits, with no request, for a different one.

The protocol it keeps to is [the transport contract][transport-contract] and
[the HTTP transport][transport-http], and the [conformance suite][conformance]
holds it there, case by case, beside the TypeScript and Rust SDKs.

## Content, and the gateway's own operations

Bytes never ride the bus. A transport's `content` uploads them and reads them
back, and the transport itself asks the gateway what a gateway answers for
itself.

```python
from semiont.http import HttpTransport
from semiont.identifiers import ResourceId
from semiont.transport import PutBinaryRequest


async def store(transport: HttpTransport, page: bytes) -> ResourceId:
    upload = transport.content.put_binary(
        PutBinaryRequest(name="A page", file=page, format="text/markdown", storage_uri="file://pages/a.md", entity_types=["Note"])
    )
    async for progress in upload:
        print(progress.bytes_uploaded, "of", progress.total_bytes)
    created = await upload

    stored = await transport.content.get_binary(created.resource_id)
    assert (stored.data, stored.content_type) == (page, "text/markdown")
    async with await transport.content.get_binary_stream(created.resource_id) as arriving:
        async for piece in arriving:
            print(len(piece))

    me = await transport.get_current_user()
    print(me.did, (await transport.health_check()).status)
    return created.resource_id
```

- **An upload** is awaited for the resource it created and iterated for its
  progress, each once. Its caller abandons it by cancelling the task that does
  either: its connection closes, and nothing is reported.
- **What is read is what was stored**, byte for byte, with its media type. A
  time or a URI in an answer is the text the gateway sent, and a field it sent
  as null is `None`.
- **A read is asked a second time** when the gateway says it will recover, or
  says nothing. A request that may already have had its effect is not.

## Ids, and the protocol's shapes

The package holds what the protocol states, as Python types: the kinds of id,
the shapes the protocol sends and answers with, the channels of its bus and
the requests made over them. Each kind of id is a type of its own, made only
from text that is one, and a type checker refuses one kind where a shape
names another.

```python
from semiont.identifiers import AnnotationId, InvalidIdentifier, ResourceId
from semiont.types import MarkDeleteCommand

resource = ResourceId("5bcd259ab1464cf68a556bbad21f513f")
assert ResourceId.parse("not an id") is None  # where text that is not an id is an ordinary answer
try:
    ResourceId("https://kb.example/resources/x")
except InvalidIdentifier as refused:
    print(refused)  # 'https://kb.example/resources/x' is not a ResourceId: it does not match ^[A-Za-z0-9_-]{1,128}$

command = MarkDeleteCommand(annotation_id=AnnotationId("a-1"), resource_id=resource)
print(command.model_dump(mode="json", exclude_unset=True))
# {'annotationId': 'a-1', 'resourceId': '5bcd259ab1464cf68a556bbad21f513f'}

# MarkDeleteCommand(annotation_id=resource) is refused by a type checker: a ResourceId is not an AnnotationId.
```

## Telemetry

The SDK takes OpenTelemetry's API and installs nothing: it does nothing until
the application it runs in installs a provider. With one, it exports what
[`specs/src/sdk-telemetry/telemetry.json`][telemetry] lists, as every Semiont
SDK does: a span for each frame sent and each received, a span for each upload
and each read, and a count of the emits sent. A request carries the trace it
is made in, and a frame continues the trace it was sent under (`frame.trace`).

## What is in the package

| Module | What it holds |
|---|---|
| `semiont.client` | `SemiontClient`, and the timing it keeps to |
| `semiont.namespaces` | The methods of each namespace, and the options they take |
| `semiont.running`, `semiont.cached` | `Running[T]` and `Cached[T]`: what long-running operations and queries return |
| `semiont.cache`, `semiont.refresh`, `semiont.resume` | The cache queries answer from and its three states, which queries each event asks again, and where a stream resumes after a restart |
| `semiont.storage` | Where a client keeps what must outlive it: `SessionStorage`, and `MemoryStorage` |
| `semiont.session` | `SemiontSession`, and `MemorySignIn` |
| `semiont.http` | `HttpTransport`, and signing in: `ServiceToken`, `AgentToken`, `sign_in_device`, `session_from_kept`, `sign_out` |
| `semiont.sign_in_store` | The sign-ins `semiont login` keeps, and where each system keeps them |
| `semiont.identifiers`, `semiont.types` | The kinds of id, and every request, response and event |
| `semiont.channels`, `semiont.operations` | The bus's channels and its operations, each a constant that carries its payload's type |
| `semiont.bus`, `semiont.event_bus` | The typed client of the bus over a transport, and a client's own in-process bus |
| `semiont.transport` | The contract a transport implements: `Transport`, `ContentTransport`, `GatewayOperations` |
| `semiont.errors`, `semiont.timing`, `semiont.retry` | The failure codes, the deadlines and the retry rules every Semiont SDK shares |
| `semiont.watched`, `semiont.events` | A value that changes and a sequence of events: what a state and a channel's frames are read as |
| `semiont.media_types` | The media types a knowledge base admits, and the rules read from them |
| `semiont.identity` | How a knowledge base is named, and the principals who act in it |
| `semiont.telemetry` | What the transports tell OpenTelemetry |
| `semiont.testing` | The doubles: `FaultyTransport`, `InMemoryContent`, `StubGateway`, `create_test_client` |

Nothing here restates the protocol by hand. `identifiers`, `types`,
`channels`, `operations`, `error_codes`, `timing`, `refresh`,
`telemetry_table`, `oauth_clients`, `sign_in` and `media_types_table` are
generated from the [specification][specs], and a gate in CI fails when one of
them differs from what the specification generates.

## Working on it

The package is [`packages/sdk-python`][package] of the
[Semiont repository][semiont], and [Testing][testing] says how its checks and
its tests are run. The programs this page shows are files of its tests, word
for word: both type checkers check them, and each one is run.

## License

Apache-2.0. See [LICENSE][license].

[semiont]: https://github.com/The-AI-Alliance/semiont
[introduction]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/INTRODUCTION.md
[quick-start]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/QUICK-START.md
[reactive-model]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/builder/REACTIVE-MODEL.md
[protocol]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/README.md
[transport-contract]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-CONTRACT.md
[transport-http]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/TRANSPORT-HTTP.md
[cache-semantics]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/protocol/CACHE-SEMANTICS.md
[conformance]: https://github.com/The-AI-Alliance/semiont/blob/main/tests/conformance/sdk/README.md
[sdk-typescript]: https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk/README.md
[sdk-rust]: https://github.com/The-AI-Alliance/semiont/blob/main/packages/sdk-rust/README.md
[launcher]: https://github.com/The-AI-Alliance/semiont/blob/main/apps/launcher/README.md
[specs]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/README.md
[surface]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/client/surface.json
[refresh]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/client/refresh.json
[codes]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/errors/codes.json
[session-cases]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/session/cases.json
[sign-in-store]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/sign-in-store/README.md
[telemetry]: https://github.com/The-AI-Alliance/semiont/blob/main/specs/src/sdk-telemetry/telemetry.json
[package]: https://github.com/The-AI-Alliance/semiont/tree/main/packages/sdk-python
[testing]: https://github.com/The-AI-Alliance/semiont/blob/main/docs/contributor/TESTING.md
[license]: https://github.com/The-AI-Alliance/semiont/blob/main/LICENSE
