# semiont-inference

The model providers [Semiont][semiont]'s Python services call, behind one
interface: ask a model for text, ask it for a JSON array of a stated shape,
and learn what the model can take.

It is for whoever writes a Semiont service in Python that asks a model
something: the Worker first. A program that only reads and writes a knowledge
base needs the SDK, [`semiont`][sdk-python], and not this package.

It runs on asyncio and requires Python 3.12 or later. It is checked by
`mypy --strict` and by `pyright` in strict mode, and ships its types
(`py.typed`). It is the Python counterpart of
[`@semiont/inference`][inference-typescript].

## What an install has

The package alone has the contract, the Ollama driver and the mock. Its
dependencies are `semiont`, `httpx`, `pydantic` and `opentelemetry-api`.

A provider's own library is not required. It comes with the extra named for
the provider, and is imported only when that provider's driver is asked for:

| Provider | Install | What the extra brings |
| --- | --- | --- |
| `ollama` | `semiont-inference` | Nothing: Ollama is asked over `httpx` |
| `anthropic` | `semiont-inference[anthropic]` | Anthropic's `anthropic` library |

An image built for one provider installs that provider's extra alone. One
that may be configured for any provider installs every extra. Asked for a
provider whose library is not installed, `create_inference_client` raises a
`ModuleNotFoundError` that names the extra to install.

## A first call

A client is made for one provider and one model, at the address the provider
is reached at. Every argument is stated: a provider that takes no key is
given `None`.

```python
from semiont_inference.factory import create_inference_client


async def ask(base_url: str) -> str:
    client = create_inference_client(provider="ollama", model="gemma2:27b", base_url=base_url, api_key=None)
    answer = await client.generate_text("Name one river of France.", max_tokens=200, temperature=0.0)
    return answer.text
```

## What a client is

`semiont_inference.interface` states it: `InferenceClient`, a protocol every
driver satisfies.

| Member | What it is |
| --- | --- |
| `provider`, `model_id` | The provider's name and the model's, as the knowledge base's config names them |
| `max_concurrency` | How many independent calls are worth running at once against this provider |
| `verify_detection_yield` | Whether a detection's extractions are to be checked by a count call |
| `limits()` | The model's ceilings, asked of the provider once and kept |
| `generate_text(prompt, max_tokens, temperature)` | The model's text, why it stopped, and the tokens the provider counted |
| `generate_structured(prompt, max_tokens, temperature, element_schema)` | A JSON array whose elements the provider held to `element_schema`, as parsed values |

Every name is imported from the module that has it: the contract and its
failures from `semiont_inference.interface`, `create_inference_client` from
`semiont_inference.factory`, and `report_limits` from
`semiont_inference.limits_report`. A driver is a module too:
`semiont_inference.anthropic.AnthropicInferenceClient`,
`semiont_inference.ollama.OllamaInferenceClient`, and, for tests,
`semiont_inference.mock.MockInferenceClient`, which answers from a list it is
given and keeps the calls made of it. `report_limits` gathers the limits of
the clients a service holds, as the protocol's `InferencePairLimits`.

## Failures

A caller tells a generation's failures apart without importing a provider's
library:

- `ProviderStatusError`: the provider refused the request with an HTTP
  status, which the error carries as `status`.
- `ProviderWithheldError`: the provider withheld its answer, by a refusal or
  a filter. It carries the provider's word for what it did as `reason`, and
  nothing the reply held is passed on.
- `StructuredReadError`: the reply could not be read as the array asked for,
  or had nothing in it. It carries the provider's `stop_reason`: `max_tokens`
  means the reply was cut off.
- Anything else is passed on as it came: a connection that ended, a network
  failure.

Limits that cannot be learned are a plain error with no status, and are not
kept: the provider is asked again at the next call.

## Cancelling

There is no parameter for it. A call is cancelled by cancelling the task that
awaits it: the request is torn down, and `asyncio.CancelledError` reaches the
caller as it is.

## Development

```bash
uv sync --locked
uv run pytest
uv run mypy
uv run pyright
uv run ruff check && uv run ruff format --check
```

The environment `uv sync` makes has every extra. The tests play each provider
over HTTP on this machine. No test reaches a real one.

[semiont]: https://github.com/The-AI-Alliance/semiont
[sdk-python]: ../sdk-python/
[inference-typescript]: ../inference/
