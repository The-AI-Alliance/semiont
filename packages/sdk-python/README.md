# semiont (Python)

Semiont's Python SDK. It holds what the protocol states, as Python types: the
kinds of id, the shapes the protocol sends and answers with, the channels of
its bus and the requests made over them, and the tables every Semiont client
keeps to. It holds the wire to a knowledge base's gateway: its bus (one
stream, kept open and resumed, with emits and requests made over it), its
content, and the gateway's own operations. And it signs in there: as an agent,
as the person `semiont login` signed in, or as a person by the device grant.
A wrong id, a wrong payload for a channel and an unhandled code or state are
errors a type checker reports.

It requires Python 3.12 or later, and runs on asyncio. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`).

```python
from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import MarkDeleteCommand

resource = ResourceId("5bcd259ab1464cf68a556bbad21f513f")
ResourceId("https://kb.example/resources/x")  # raises InvalidIdentifier: a URI is not an id
ResourceId.parse("not an id")  # None

command = MarkDeleteCommand(annotation_id=AnnotationId("a-1"), resource_id=resource)
command.model_dump(mode="json", exclude_unset=True)
# {'annotationId': 'a-1', 'resourceId': '5bcd259ab1464cf68a556bbad21f513f'}

MarkDeleteCommand(annotation_id=resource)  # refused by a type checker: a ResourceId is not an AnnotationId
```

## The bus

A transport is held with `async with`. Its stream opens inside, once there is
a token, and everything it started has ended on the way out.

```python
from semiont.bus import request
from semiont.errors import BusRequestError
from semiont.http import HttpTransport
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_RESOURCE_REQUESTED
from semiont.watched import Variable


async def read(origin: str, token: str, resource: ResourceId) -> None:
    async with HttpTransport(origin, token=Variable[str | None](token)) as transport:
        try:
            reply = await request(transport, BROWSE_RESOURCE_REQUESTED, {"resourceId": resource})
        except BusRequestError as error:
            print(error.code)  # "bus.not-found", "bus.timeout", …: a closed vocabulary
            return
        print(reply["response"])

        # Frames arrive on a resource's channels while its scope is held.
        with transport.subscribe_to_resource(resource):
            async with transport.frames("mark:added") as added:
                async for frame in added:
                    print(frame.scope, frame.payload)
```

- **A request** waits for the stream to be open before it is sent, is answered
  once, and is abandoned by cancelling the task that awaits it.
- **Frames** are a sequence: each reader is given every one, in order, however
  far behind it falls.
- **The connection's state** (`transport.state`) is a value: what it is now,
  and each thing it becomes. A dropped stream is a state, never an error, and
  opens again by itself.
- **Failures** are `SemiontError`s under the codes of
  `specs/src/errors/codes.json`. What a server refused is also on
  `transport.failures()`.
- **The token** is a value the transport watches: when it changes, the next
  request carries the new one. A stream the gateway refused as unauthorized
  asks its `refresher` for another token, once per outage, and with none
  waits, with no request, for a different one.

The protocol it keeps to is `docs/protocol/TRANSPORT-CONTRACT.md` and
`docs/protocol/TRANSPORT-HTTP.md`, and the suite in `tests/conformance/sdk`
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


async def work(gateway: str, issuer: str, secret: str) -> None:
    service = ServiceToken(Credential(issuer=issuer, client_id="semiont-smelter", client_secret=secret))
    async with (
        AgentToken(gateway, provider="ollama", model="gemma2:27b", service=service) as agent,
        HttpTransport(gateway, token=agent.token, refresher=agent.refresh, channels=reply_channels_for(JOB_CLAIM)) as transport,
    ):
        print(transport.state.value)
```

**A person** is signed in at the issuer the knowledge base trusts, and the
sign-in is kept. `semiont login` keeps one for each stack, and a session here
is built over it; a script on a machine with no launcher makes its own by the
device grant, which shows a code to approve in any browser. No password
passes through this process.

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
        print(session.user.value, (await session.transport.get_status()).version)
```

- **An agent whose renewal fails keeps the token it has** and tries again: a
  process holding a token that still works does not stop over one bad round
  trip. Signing in is the one step that raises.
- **A person's session ends once, and says why.** A token the issuer will not
  renew ends it as `expired`, and a token the issuer has just issued and the
  gateway refuses ends it as `refused` (`on_auth_failed`). The sign-in is
  then forgotten, so a dead credential is never sent again. What a session
  does at its start and when it is refused is
  `specs/src/session/cases.json`, row for row.
- **A renewal spends its refresh token once.** Renewals asked for together are
  one request of the issuer, a renewal the issuer did not refuse is tried
  again inside a bounded budget, and one under way runs to its end whoever
  stops waiting for it.
- **The store is the launcher's** (`specs/src/sign-in-store`): the same file
  and the same lock, on macOS, Linux and Windows. A sign-in made here serves
  the launcher's verbs, and one it renewed serves this session.
  `MemorySignIn` keeps one for the life of the process instead, and
  `sign_out` revokes one at its issuer and forgets it.
- **Nothing here reads the environment.** An application reads its own
  (`HOME`, a secret, an address) and says what it found.

## Telemetry

The SDK takes OpenTelemetry's API and installs nothing: it does nothing until
the application it runs in installs a provider. With one, it exports what
`specs/src/sdk-telemetry/telemetry.json` lists, as every Semiont SDK does: a
span for each frame sent and each received, a span for each upload and each
read, and a count of the emits sent. A request carries the trace it is made
in, and a frame continues the trace it was sent under (`frame.trace`).

## What is generated, and from what

Nothing here restates the protocol by hand. Each module below is generated
from `specs/`, committed, and held by a drift gate in CI.

| Module | From | By |
|---|---|---|
| `semiont.identifiers` | `specs/src/identifiers/kinds.json` and each kind's schema | `node scripts/spec/generate-identifiers-python.mjs` |
| `semiont.types` | the bundled OpenAPI spec | `uv run python scripts/generate_models.py` |
| `semiont.channels`, `semiont.operations` | `specs/src/bus/registry.json` | `node scripts/bus/generate-python.mjs` |
| `semiont.error_codes` | `specs/src/errors/codes.json` | `node scripts/spec/generate-error-codes-python.mjs` |
| `semiont.timing` | `specs/src/client/timing.json` | `node scripts/spec/generate-client-timing-python.mjs` |
| `semiont.refresh` | `specs/src/client/refresh.json` | `node scripts/spec/generate-cache-refresh-python.mjs` |
| `semiont.telemetry_table` | `specs/src/sdk-telemetry/telemetry.json` | `node scripts/spec/generate-sdk-telemetry-python.mjs` |
| `semiont.oauth_clients` | `specs/src/session/oauth.json` | `node scripts/spec/generate-oauth-clients-python.mjs` |
| `semiont.sign_in` | `specs/src/sign-in-store/SignIn.json` | `node scripts/spec/generate-sign-in-python.mjs` |

## Working on it

```bash
uv sync                                  # the locked environment
uv run mypy                              # both checkers, strict
uv run pyright
uv run pytest
uv run ruff check && uv run ruff format --check
```

`tests/refusals` holds programs that must not type-check. Each wrong line
names the error it must raise, and a line that stops raising it fails the
checker that stopped.
