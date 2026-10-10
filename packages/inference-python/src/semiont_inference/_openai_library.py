"""OpenAI's `openai` library, as this package sets it up for whichever of its modules asks through it.

Two modules ask through the library: the OpenAI driver
(`semiont_inference.openai`), by the Responses API, and the client the vLLM
and llama.cpp drivers share (`semiont_inference._chat_completions`), by the
Chat Completions API. What both decide about the library is decided here,
once: the client as it is made (`open_library`), and the headers of a request
(`request_headers`). What a request says and how its reply is read are each
module's own.

**What the library does on its own, and what is done about each** (`openai`,
read at 3.28.0, so that a new release of it is read for the same):

- Its HTTP client takes a proxy and its trusted certificates from the
  environment (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR`), and follows redirects. The client made
  here does neither: the address it was given is the address asked.
- It adds headers that describe itself and the machine it runs on
  (`X-Stainless-*`: its version, the operating system, the architecture, the
  Python runtime and its version, how long it waits for a read), an
  `OpenAI-Organization` and an `OpenAI-Project` read from `OPENAI_ORG_ID` and
  `OPENAI_PROJECT_ID`, and every line of `OPENAI_CUSTOM_HEADERS`. An
  `Authorization` among those lines replaces the key the client was given.
  Every header the library would add is left off each request by name, and
  what a request needs is stated: `Accept`, `User-Agent` (the library's name
  and version), `Content-Type` where there is a body, and `Authorization`
  where there is a key.
- It refuses to be made without a key, and sends the key it has with every
  request. A server that asks for no key is sent no `Authorization`: the
  library is made with a word that is never sent (`_NO_KEY`), and the header
  is left off.
- It waits ten minutes for each read, and sends a request that timed out
  again, twice, with nothing that tells the provider it is the same request.
  A request made through this client has no bound on a read (`_TIMEOUT`),
  unless it states one of its own, so no generation is started a second time
  for being slow.
- It asks again, `max_retries` times, for a request the provider refused with
  408, 409, 429 or 500 and above, and for one whose connection failed. It
  waits as long as a `retry-after` header says, up to two minutes, and does
  not ask again at all where the header says longer. `_MAX_RETRIES` states
  how many times.
- It builds a reply into typed models without checking it. Each module reads
  a reply as the JSON the provider wrote, and says how.

**What of it is not switched off**, because the library has no argument for
it:

- `OPENAI_LOG`, read when the library is imported: it sets the level of the
  library's logger and configures the root logger. What the library logs is a
  request's method, status, retry count and id, and no address, header or
  body.
- `OPENAI_ADMIN_KEY` and `OPENAI_WEBHOOK_SECRET` are read and kept by every
  client. Neither is sent: a request's `Authorization` is the one stated
  here, or none.
- A request whose answer is asked for as the provider wrote it
  (`with_raw_response`) carries `X-Stainless-Raw-Response: true`. The library
  reads that mark back itself. Each module says which of its requests are
  asked so.
- It reads what platform it runs on, for headers that are not sent: in a
  thread at each client's first request, and once in the process, where it is
  asked, when it is first asked here which headers it would add.
- `OPENAI_API_KEY` and `OPENAI_BASE_URL` are read only by a client given no
  key or no address. The client made here is given both.
- When it is imported it also reads `DEFER_PYDANTIC_BUILD`, which decides
  when its own models are built, and `OPENAI_API_TYPE`, `OPENAI_API_VERSION`
  and `AZURE_OPENAI_ENDPOINT`, for a client of the module's own that nothing
  here uses.

Its failures: `APIStatusError` carries the status the provider refused with;
`APIConnectionError` carries none. It has no failure of its own for a call
that was cancelled, and catches no cancellation.
"""

from typing import Final

from openai import AsyncOpenAI, DefaultAsyncHttpx2Client, Omit, Timeout, omit

# How long a generation may take. Asked for whole, a provider's answer is one
# HTTP response, and any bound on the wait for it would be a ceiling on a
# generation's length that no caller chose. The library would also answer that
# bound by sending the request again. So there is none, on sending or on the
# answer: a generation ends when it is answered or when its caller cancels it,
# and that is its one bound. Reaching the provider at all is bounded, at ten
# seconds, as it is in the Ollama driver.
_TIMEOUT: Final = Timeout(None, connect=10.0)

# How many times the library asks again for a request that failed. Chosen, and
# not left to the library: two is its default today, and written here a release
# of the library cannot change it unnoticed.
#
# Two rests on what was measured of the Anthropic driver, whose library asks
# again by the same rule: a failure that comes quickly (a 429, a 409, a quick
# 5xx, a connection refused) costs seconds, and the library waits as long as
# `retry-after` says. Nothing has been measured against OpenAI, or against a
# server asked through this library. With no bound on a read, a slow generation
# is never one of the tries.
#
# What would change it: a generation that runs for minutes and then loses its
# connection, again and again. Each try starts it from nothing, and its tries
# together can outlast the worker's bound. If that is seen, lower this number.
_MAX_RETRIES: Final = 2

# What the library is made with where there is no key: it refuses to be made
# with none. It is never sent, since `Authorization` is then left off by name.
_NO_KEY: Final = "no-key"

# The headers the library adds to each attempt beside its defaults.
_ADDED_TO_EACH_ATTEMPT: Final = ("x-stainless-retry-count", "x-stainless-read-timeout")


def open_library(*, api_key: str | None, base_url: str) -> AsyncOpenAI:
    """The library's client of the API at `base_url`, for one call. `api_key` is None for a server that asks for no key.

    Held with `async with`, it is closed when the call ends, so a driver
    holds nothing open and has nothing to close.

    Its HTTP client is stated, and not left to the library: one that takes
    no proxy and no certificates from the environment, and follows no
    redirect.
    """
    return AsyncOpenAI(
        api_key=_NO_KEY if api_key is None else api_key,
        base_url=base_url,
        max_retries=_MAX_RETRIES,
        timeout=_TIMEOUT,
        http_client=DefaultAsyncHttpx2Client(trust_env=False, follow_redirects=False),
    )


def request_headers(library: AsyncOpenAI, *, api_key: str | None, with_a_body: bool) -> dict[str, str | Omit]:
    """The headers of a request made through `library`: every one the library would add left off, and those a request needs stated.

    `api_key` is the key `library` was opened with, or None where it was
    opened with none.

    What the library would add is asked of the library, so that a header a
    later release adds, and whatever the environment names, is left off with
    the rest. The library reads a header's name without regard to its case,
    in the order given, and the last word on a name is what it sends. So
    what is stated is said after everything that is left off: a line of the
    environment's, however it spells a name, cannot stand in for the key or
    take a stated header away.
    """
    stated: dict[str, str | Omit] = {"Accept": "application/json", "User-Agent": library.user_agent}
    if with_a_body:
        stated["Content-Type"] = "application/json"
    if api_key is not None:
        stated["Authorization"] = f"Bearer {api_key}"
    would_add = (*library.default_headers, *_ADDED_TO_EACH_ATTEMPT, "Authorization")
    left_off: dict[str, str | Omit] = {name: omit for name in would_add if name not in stated}
    return {**left_off, **stated}
