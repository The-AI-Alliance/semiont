# Python

The first is how a Python program uses Semiont. The other four are what the Python services are built from.

| Distribution | Published | Coverage | What it is |
|---|---|---|---|
| [semiont](./sdk/README.md) | [![PyPI](https://img.shields.io/pypi/v/semiont.svg)](https://pypi.org/project/semiont/) | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=python-sdk)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=python-sdk) | The Python SDK: the client of a knowledge base, its transport over a gateway, signing in, live queries, and the doubles a test is built on. On asyncio, typed for `mypy` and `pyright` |
| [semiont-service](./service/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=python-service)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=python-service) | What every Python service does to be one: read its configuration document, answer for its health, write its log and export its telemetry |
| [semiont-inference](./inference/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=python-inference)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=python-inference) | The model providers a Python service calls, behind one interface: text and structured generation, and discovered limits. A provider's own library is an extra |
| [semiont-graph](./graph/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=python-graph)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=python-graph) | The graph databases a Python service writes and reads, behind one interface. A database's own client is an extra |
| [semiont-vectors](./vectors/README.md) | Not published | [![codecov](https://codecov.io/gh/The-AI-Alliance/semiont/graph/badge.svg?flag=python-vectors)](https://codecov.io/gh/The-AI-Alliance/semiont?flag=python-vectors) | The vector index a Python service writes and searches, and the embedding providers that make its vectors, each behind one interface |

## Where things are

- Each package is a uv project of its own, with its own `uv.lock`; a package that builds on another names it as a path dependency.
- Each measures its coverage with `uv run pytest --cov`, which CI uploads under the flag `python-<name>`.

The other languages, and which SDK a program installs, are in [packages/](../README.md).
