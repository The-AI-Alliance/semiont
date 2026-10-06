# semiont (Python)

Semiont's Python SDK. It holds what the protocol states, as Python types: the
kinds of id, the shapes the protocol sends and answers with, the channels of
its bus and the requests made over them, and the tables every Semiont client
keeps to. A wrong id, a wrong payload for a channel and an unhandled code are
errors a type checker reports.

It requires Python 3.12 or later. It is checked by `mypy --strict` and by
`pyright` in strict mode, and ships its types (`py.typed`).

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
