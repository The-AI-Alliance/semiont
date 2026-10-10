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

The library a driver asks its provider through is not required. It comes
with the extra named for the provider, and is imported only when that
provider's driver is asked for:

| Provider | Install | What the extra brings |
| --- | --- | --- |
| `ollama` | `semiont-inference` | Nothing: Ollama is asked over `httpx` |
| `anthropic` | `semiont-inference[anthropic]` | Anthropic's `anthropic` library |
| `openai` | `semiont-inference[openai]` | OpenAI's `openai` library |
| `google` | `semiont-inference[google]` | Google's `google-genai` library |
| `together` | `semiont-inference[together]` | Together's `together` library |
| `vllm` | `semiont-inference[vllm]` | OpenAI's `openai` library, which a vLLM server is asked through |
| `llamacpp` | `semiont-inference[llamacpp]` | OpenAI's `openai` library, which llama.cpp's server is asked through |

An image built for one provider installs that provider's extra alone. One
that may be configured for any provider installs every extra. Asked for a
provider whose library is not installed, `create_inference_client` raises a
`ModuleNotFoundError` that names the extra to install.

`create_inference_client` makes a client for the providers the protocol
names: `ollama` and `anthropic`. The other five drivers are each imported
from their own module, which raises the same failure where the library is
not installed.

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
| `limits()` | The model's ceilings, asked of the provider once and kept, or, where the provider states none, as the client was handed them |
| `generate_text(prompt, max_tokens, temperature)` | The model's text, why it stopped, and the tokens the provider counted |
| `generate_structured(prompt, max_tokens, temperature, element_schema)` | A JSON array whose elements the provider held to `element_schema`, as parsed values |

Every name is imported from the module that has it: the contract and its
failures from `semiont_inference.interface`, `create_inference_client` from
`semiont_inference.factory`, `report_limits` from
`semiont_inference.limits_report`, and what reads a model catalogue from
`semiont_inference.catalogue`. A driver is a module too:

| Provider | Its client |
| --- | --- |
| Anthropic | `semiont_inference.anthropic.AnthropicInferenceClient` |
| Google's Gemini, by the Developer API | `semiont_inference.google.GoogleInferenceClient` |
| llama.cpp's server | `semiont_inference.llamacpp.LlamaCppInferenceClient` |
| Ollama | `semiont_inference.ollama.OllamaInferenceClient` |
| OpenAI | `semiont_inference.openai.OpenAIInferenceClient` |
| Together AI | `semiont_inference.together.TogetherInferenceClient` |
| vLLM | `semiont_inference.vllm.VllmInferenceClient` |

For tests there is `semiont_inference.mock.MockInferenceClient`, which
answers from a list it is given and keeps the calls made of it.
`report_limits` gathers the limits of the clients a service holds, as the
protocol's `InferencePairLimits`.

A provider is who serves the model, and not whose API the request is shaped
by: vLLM and llama.cpp's server are asked by OpenAI's Chat Completions API,
and each is a provider of its own.

## Failures

A caller tells a generation's failures apart without importing a provider's
library:

- `ProviderStatusError`: the provider refused a request with an HTTP
  status, which the error carries as `status`: a generation, or what learns
  a model's limits.
- `StructuredUnsupportedError`: a structured generation was asked of a model
  not known to hold a reply to a schema. The driver refuses it and asks for
  no generation, and its message names the model. The Anthropic driver
  refuses a model its provider does not report as holding a reply to one.
  The OpenAI, Google and Together drivers refuse a model whose catalogue
  facts do not say it does. The Ollama, vLLM and llama.cpp drivers refuse no
  model.
- `ProviderWithheldError`: the provider withheld its answer, by a refusal or
  a filter. It carries the provider's word for what it did as `reason`, and
  nothing the reply held is passed on. Anthropic, OpenAI and Google signal
  one. Ollama, Together, vLLM and llama.cpp's server have no signal for it:
  what a model they serve declines, it declines in its text.
- `StructuredReadError`: the reply could not be read as the array asked for,
  or had nothing in it. It carries the provider's `stop_reason`: `max_tokens`
  means the reply was cut off.
- Anything else is passed on as it came: a connection that ended, a network
  failure.

Limits that cannot be learned are not kept: the provider is asked again at
the next call. Where the provider refused with a status, a wrong key or a
provider that is overloaded, the failure is a `ProviderStatusError` whose
message says what was being learned and the status. Where there was no
status (a connection that ended, an answer that does not state the limits, a
model a list does not have) it is a plain error.

Anthropic's library asks again for a request the provider refused for the
moment, and waits first as long as the refusal says. The Anthropic driver
lets it wait two minutes at the most. A refusal that says longer is raised at
once, as the `ProviderStatusError` it is, the request is not made again, and
the message says the wait the provider stated. That is so of every request
the driver makes: a generation, and each of the two that learn a model's
limits.

## Cancelling

There is no parameter for it. A call is cancelled by cancelling the task that
awaits it: the request is torn down, and `asyncio.CancelledError` reaches the
caller as it is.

## A model catalogue

Some providers' APIs do not state what a model can take: its context window,
the most it writes, whether it holds a reply to a schema, whether it takes a
temperature, how its reasoning is set. [models.dev][models-dev] is an open
database that does, kept by its maintainers from each provider's
documentation.

A driver whose provider is silent takes those facts from a catalogue file:
the part of that database a driver reads, for three providers (`openai`,
`google` and `togetherai`, by the catalogue's names). This package
carries no copy of it and downloads nothing. It reads a file it is pointed
to:

- `semiont_inference.catalogue` is the reader. `read_catalogue` takes the
  path of a catalogue file and answers what the file holds. A file that is
  not there, or is not a catalogue, is a failure that names the path: there
  is no other place the package looks, and no environment variable it reads.
  `catalogue_facts` answers one model's facts from what was read, or `None`
  for a model the file does not have. A fact the catalogue does not state is
  `None`, and never a value in its place.
- The file is made when an image is built, by
  `scripts/inference/generate-model-catalogue.mjs` of the repository, from the
  npm package `@opencode-ai/models` at the one version the repository's
  `package.json` pins. The script writes `model-catalogue.json`, which says
  that package and that version at its top, and `model-catalogue.LICENSE`
  beside it: the catalogue is models.dev's, under the MIT licence, which asks
  that its notice go with a copy.

A file is as old as the image that carries it, and a model released since is
not in it.

A fact read from a catalogue is the catalogue's word, and not the provider's.
A driver takes it only for what its provider's API does not state. The
Anthropic, Ollama, vLLM and llama.cpp drivers ask their providers, and take
nothing from a catalogue. The other three read no file either: whoever makes
one hands it the model's `CatalogueFacts`.

- The OpenAI driver asks its provider nothing about a model. Its limits too
  are the catalogue's.
- The Google driver asks its provider for a model's limits, and is handed the
  rest: whether the model holds a reply to a schema, whether it takes a
  temperature, and how its reasoning is set.
- The Together driver asks its provider for a model's context window, which
  is all Together's API states of a model, and is handed the rest, the most
  the model writes among it. It never states the most a model writes above
  its window. Where Together's list states no window for the model, the
  catalogue's is used, and the driver logs that it is the catalogue's word.

Each of the three refuses a structured generation to a model whose facts do
not say it holds a reply to a schema, with a `StructuredUnsupportedError`. A
catalogue leaves that unsaid of many models, and such a model is refused
whatever its provider would have done.

The repository keeps one generated file, in this package's `tests/catalogue`.
It is the tests' fixture: real data at the pin, which
`npm run generate:model-catalogue` writes and CI holds to the pin. Neither a
wheel nor a source distribution of the package holds it.

## Development

```bash
uv sync --locked
uv run pytest
uv run mypy
uv run pyright
uv run ruff check && uv run ruff format --check
```

The environment `uv sync` makes has every extra. The tests play each provider
over HTTP on this machine. No test reaches a real one. One test builds the
package's wheel and source distribution with `uv build`, to read what each
holds.

[semiont]: https://github.com/The-AI-Alliance/semiont
[models-dev]: https://models.dev
[sdk-python]: ../sdk-python/
[inference-typescript]: ../inference/
