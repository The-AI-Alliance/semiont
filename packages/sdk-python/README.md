# semiont (Python)

Semiont's Python SDK. It holds what the protocol states, as Python types: the
kinds of id, the shapes the protocol sends and answers with, the channels of
its bus and the requests made over them, and the tables every Semiont client
keeps to. And it holds a knowledge base's bus over its gateway: one stream,
kept open and resumed, with emits and requests made over it. A wrong id, a
wrong payload for a channel and an unhandled code or state are errors a type
checker reports.

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
- **The token** is a `Variable`: set it, and the next request carries the new
  one. A stream the gateway refused as unauthorized waits, with no request,
  for a different token.

The protocol it keeps to is `docs/protocol/TRANSPORT-CONTRACT.md` and
`docs/protocol/TRANSPORT-HTTP.md`, and the suite in `tests/conformance/sdk`
holds it there, case by case, beside the TypeScript and Rust SDKs.

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
