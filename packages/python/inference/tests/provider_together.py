"""Together's API, played: the two calls the Together driver makes through Together's own library.

`GET /v1/models` is the model list, which is all the API states of a model.
`POST /v1/chat/completions` is a generation, answered whole. A request nothing
was scripted for, and a request of any other path, lands in `unscripted`,
which fails the test on the way out.
"""

from dataclasses import dataclass
from typing import final, override

from provider import Answer, Asked, Played, saying
from pydantic import JsonValue
from spec import JsonObject


def together_error(status: int, *, kind: str, code: str | None, message: str, headers: dict[str, str] | None = None) -> Answer:
    """A refusal as Together's API states one.

    With no `headers` given it asks to be tried again at once, so a test of
    the library's retries does not wait.
    """
    stated = {"retry-after-ms": "1"} if headers is None else headers
    return saying({"error": {"message": message, "type": kind, "param": None, "code": code}}, status=status, headers=stated)


def listed(model_id: str, **stated: JsonValue) -> JsonObject:
    """One model's entry in the model list: the four members the API always states, and what `stated` adds."""
    return {"id": model_id, "object": "model", "created": 1_760_000_000, "type": "chat", **stated}


def model_list(*entries: JsonObject) -> Answer:
    """What the model list answers: every model, as one array."""
    return saying([*entries])


def choice(
    content: str | None,
    *,
    finish_reason: str | None = "stop",
    reasoning: str | None = None,
    reasoning_content: str | None = None,
    index: int = 0,
) -> JsonObject:
    """One choice of a reply: the model said `content`, and stopped for `finish_reason`.

    Its thinking is stated only when given, under the name it is given by:
    the API has two, and which a model uses is the model's.
    """
    said: JsonObject = {"role": "assistant", "content": content}
    if reasoning is not None:
        said["reasoning"] = reasoning
    if reasoning_content is not None:
        said["reasoning_content"] = reasoning_content
    return {"index": index, "finish_reason": finish_reason, "message": said}


def counted(prompt_tokens: int, completion_tokens: int, *, reasoning_tokens: int = 0) -> JsonObject:
    """A reply's `usage`, as a reasoning model's reply states one. What was written includes what was spent reasoning."""
    return {
        "prompt_tokens": prompt_tokens,
        "completion_tokens": completion_tokens,
        "total_tokens": prompt_tokens + completion_tokens,
        "completion_tokens_details": {"reasoning_tokens": reasoning_tokens},
    }


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Completed:
    """What the API answers a generation with: the reply's choices, and what the provider counted."""

    choices: list[JsonObject]
    usage: JsonObject | None


def completed(text: str | None, *, finish_reason: str | None = "stop", usage: JsonObject | None = None) -> Completed:
    """A reply of one choice that holds `text`. With no `usage` given it reports ten tokens read and five written."""
    return Completed(choices=[choice(text, finish_reason=finish_reason)], usage=counted(10, 5) if usage is None else usage)


def whole(said: Completed, *, model: JsonValue, number: int) -> Answer:
    """The answer that carries `said`: the reply of the `number`th generation asked of `model`, with the provider's id of it."""
    return saying(
        {
            "id": f"played-{number}",
            "object": "chat.completion",
            "created": 1_760_000_000,
            "model": model,
            "prompt": [],
            "choices": [*said.choices],
            "usage": said.usage,
        }
    )


@final
class Together(Played):
    """A stand-in for Together's API.

    `models` is what the model list answers. `script` queues what the next
    generations are answered with. A driver is given `base_url`: the address
    a config names ends in `/v1`.
    """

    def __init__(self, *models: JsonObject) -> None:
        super().__init__()
        self.models: Answer = model_list(*models)
        self._scripted: list[Completed | Answer] = []

    @property
    def base_url(self) -> str:
        """The address of the API, as a config names it."""
        return f"{self.origin}/v1"

    def script(self, *replies: Completed | Answer) -> None:
        """What the next generations are answered with, in order, after those already scripted."""
        self._scripted.extend(replies)

    @property
    def lists(self) -> list[Asked]:
        """Every `GET /v1/models`, in order."""
        return self.of("GET", "/v1/models")

    @property
    def completions(self) -> list[Asked]:
        """Every `POST /v1/chat/completions`, in order."""
        return self.of("POST", "/v1/chat/completions")

    @property
    def generations(self) -> list[JsonObject]:
        """The body of every generation, in order."""
        return [asked.json() for asked in self.completions]

    @override
    def _answer(self, asked: Asked) -> Answer:
        if (asked.method, asked.path) == ("GET", "/v1/models"):
            return self.models
        if (asked.method, asked.path) != ("POST", "/v1/chat/completions"):
            self.unscripted.append(f"{asked.method} {asked.path}")
            return saying({"error": {"message": "not found", "type": "invalid_request_error", "param": None, "code": None}}, status=404)
        asked_so_far = len(self.completions)
        if not self._scripted:
            self.unscripted.append(f"generation {asked_so_far}")
            unscripted: JsonObject = {"message": "the stand-in has no reply scripted", "type": "server_error", "param": None, "code": None}
            return saying({"error": unscripted}, status=500)
        scripted = self._scripted.pop(0)
        if isinstance(scripted, Answer):
            return scripted
        return whole(scripted, model=asked.json()["model"], number=asked_so_far)
