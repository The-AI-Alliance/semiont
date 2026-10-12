# semiont-service

What every Python service of [Semiont][semiont] does to be one: read its
configuration document, answer for its health, write its log, and export its
telemetry. A service that follows the record also takes from it the order it
works in, and how it reads the catalog of resources. The [Worker][worker], the [Weaver][weaver] and the
[Smelter][smelter] are built on it.

It is the services' own code and no library for anyone else: no index holds
it, and each service's image builds it from this repository. A program that
reads and writes a knowledge base needs the SDK, [`semiont`][sdk-python], and
not this package.

It runs on asyncio and requires Python 3.12 or later. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`), which the services are checked against.

## What is in it

| Module | What it does | What the service hands it |
| --- | --- | --- |
| `semiont_service.catalog` | Reads the catalog of resources whole from the Archivist, a page at a time, and asks for a page again while the Archivist is not there to answer | Its bus, what tells it the service is stopping, and whether it wants the archived resources |
| `semiont_service.config` | Finds the document `--config` names, reads it as a shape of the protocol and refuses what is not one, and reads the service's account from its environment | Its word for itself, the shape, its arguments and its environment |
| `semiont_service.health` | Answers `GET /health`, and nothing else, on the service's port | What the endpoint says, asked afresh for each request |
| `semiont_service.lanes` | Does what is put on a lane one piece at a time, in the order it was put there, with the lanes working beside each other, and does one piece of work with no lane working | The lane of each piece of work, which is a resource's id for a service that follows the record |
| `semiont_service.log` | Writes the process's log to stdout, an event a line, as JSON or plainly, from the level the document names | Its word for itself, and the names of the loggers that are its own |
| `semiont_service.observability` | Exports spans and metrics as the environment says, or installs nothing, and takes the readings every service takes of itself | Its word for itself, and its environment |

A service is known by one word in lower case, as its image and its container
are named: `worker`, `weaver`. Its refusals and its log lines say that word,
and its distribution, and the name its telemetry is exported under, is that
word after `semiont-`.

Nothing here reads the process's environment or its arguments. The service
reads them, in one module, and hands them on.

## What a change must keep

- **An operator reads one kind of message from every service.** A refusal is
  worded as the gateway's, the Dispatcher's and the Archivist's are, and never
  repeats a value the document held. Each service's conformance suite holds
  the words to a started process.
- **What a process exports of itself is the telemetry table's.** The readings
  registered here are rows of
  [`specs/src/service-telemetry/telemetry.json`][telemetry], and the tests
  hold each to its row.
- **OpenTelemetry's SDK and its exporter are stated here, once.** A service
  requires this package and states no version of either.
- **A service keeps no copy of a module here.** `tests/test_census.py` holds
  every Python service of the repository to that.

## Testing

```bash
uv sync --locked
uv run pytest
```

[semiont]: https://github.com/The-AI-Alliance/semiont
[worker]: ../../apps/worker/README.md
[weaver]: ../../apps/weaver/README.md
[smelter]: ../../apps/smelter/README.md
[sdk-python]: ../sdk-python/README.md
[telemetry]: ../../specs/src/service-telemetry/telemetry.json
