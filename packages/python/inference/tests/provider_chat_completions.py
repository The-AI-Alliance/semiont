"""A server that speaks OpenAI's Chat Completions API, played: it answers as vLLM does or as llama.cpp's server does.

`ChatCompletions` plays the two calls a driver makes through OpenAI's
library: `GET /v1/models`, the model list, where each server states a model's
window in a member of its own; and `POST /v1/chat/completions`, a generation,
answered whole. What each server says in its own way (an entry of its list, a
refusal) is made by a function named for it.

A request nothing was scripted for, and a request of any other path, lands in
`unscripted`, which fails the test on the way out.

`alone` runs a program in an interpreter of its own, for what a process does
once: importing a library, installing a meter provider.
"""

import subprocess
import sys
from dataclasses import dataclass, field
from typing import final, override

from provider import Answer, Asked, Played, saying
from pydantic import JsonValue
from spec import JsonObject

# ── what each server's model list says ──────────────────────────────────


def vllm_entry(model: str, max_model_len: int | None, *, parent: str | None = None) -> JsonObject:
    """An entry of vLLM's model list: a served model, which states its window, or an adapter, which states its parent and a null window."""
    return {
        "id": model,
        "object": "model",
        "created": 1_760_000_000,
        "owned_by": "vllm",
        "root": f"/models/{model}",
        "parent": parent,
        "max_model_len": max_model_len,
        "permission": [],
    }


def llamacpp_entry(model: str, n_ctx: int | None, *, aliases: list[str] | None = None) -> JsonObject:
    """An entry of llama.cpp's model list. With `n_ctx` None its `meta` is null, as it is while the model loads.

    A model's `id` is the first of the names it is served under, and
    `aliases` is all of them. With no `aliases` given the model has the one
    name.
    """
    meta: JsonObject | None = (
        None
        if n_ctx is None
        else {
            "vocab_type": 2,
            "n_vocab": 128_256,
            "n_ctx": n_ctx,
            "n_ctx_train": 131_072,
            "n_embd": 4096,
            "n_params": 8_030_261_312,
            "size": 4_912_898_304,
            "ftype": 15,
        }
    )
    return {
        "id": model,
        "aliases": [model] if aliases is None else [*aliases],
        "tags": [],
        "object": "model",
        "architecture": {"input_modalities": ["text"], "output_modalities": ["text"]},
        "created": 1_760_000_000,
        "owned_by": "llamacpp",
        "meta": meta,
    }


def listing(*entries: JsonObject) -> Answer:
    """What `GET /v1/models` answers: a list of `entries`."""
    return saying({"object": "list", "data": [*entries]})


# ── how each server refuses ─────────────────────────────────────────────


def vllm_error(status: int, kind: str, message: str, *, param: str | None = None, headers: dict[str, str] | None = None) -> Answer:
    """A refusal as vLLM states one: its `code` is the status, as a number.

    With no `headers` given it asks to be tried again at once, so a test of
    the library's retries does not wait. vLLM itself says no such thing.
    """
    stated = {"retry-after-ms": "1"} if headers is None else headers
    return saying({"error": {"message": message, "type": kind, "param": param, "code": status}}, status=status, headers=stated)


def llamacpp_error(
    status: int, kind: str, message: str, *, beside: JsonObject | None = None, headers: dict[str, str] | None = None
) -> Answer:
    """A refusal as llama.cpp's server states one, with whatever it states `beside` the message.

    With no `headers` given it asks to be tried again at once, so a test of
    the library's retries does not wait. The server itself says no such thing.
    """
    stated = {"retry-after-ms": "1"} if headers is None else headers
    return saying({"error": {"code": status, "message": message, "type": kind, **(beside or {})}}, status=status, headers=stated)


# ── a generation ────────────────────────────────────────────────────────


def spent(prompt_tokens: int, completion_tokens: int) -> JsonObject:
    """A reply's `usage`, as the Chat Completions API states one."""
    return {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens, "total_tokens": prompt_tokens + completion_tokens}


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Completed:
    """What a server answers a generation with: one choice, why the model stopped, and what the server counted."""

    content: str | None
    usage: JsonObject | None
    """With None the reply states no `usage` at all."""
    finish_reason: str | None = "stop"
    beside: JsonObject = field(default_factory=dict[str, JsonValue])
    """What the message holds beside its content: a model's thinking, under the server's own name for it."""


def completed(content: str | None, *, finish_reason: str | None = "stop", usage: JsonObject | None = None, **beside: str) -> Completed:
    """A reply whose message holds `content`. With no `usage` given it reports ten tokens read and five written."""
    return Completed(content=content, usage=spent(10, 5) if usage is None else usage, finish_reason=finish_reason, beside={**beside})


def whole(*choices: JsonObject, usage: JsonObject | None = None) -> Answer:
    """A reply of exactly these `choices`, for a shape `Completed` does not make."""
    return saying({"id": "chatcmpl-played", "object": "chat.completion", "model": "played", "choices": [*choices], "usage": usage})


def choice(content: str | None, *, finish_reason: str | None = "stop") -> JsonObject:
    """One choice of a reply."""
    return {"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": finish_reason}


@final
class ChatCompletions(Played):
    """A stand-in server. `models` is what `GET /v1/models` answers; `script` queues what the next generations are answered with.

    A driver is given `base_url`: the address a config names ends in `/v1`.
    """

    def __init__(self, models: Answer) -> None:
        super().__init__()
        self.models: Answer = models
        self._scripted: list[Completed | Answer] = []

    @property
    def base_url(self) -> str:
        """The address of the API, as a config names it."""
        return f"{self.origin}/v1"

    def script(self, *replies: Completed | Answer) -> None:
        """What the next generations are answered with, in order, after those already scripted."""
        self._scripted.extend(replies)

    @property
    def listings(self) -> list[Asked]:
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

    @property
    def paths(self) -> list[str]:
        """The method and path of every request, in order."""
        return [f"{asked.method} {asked.path}" for asked in self.asked]

    @override
    def _answer(self, asked: Asked) -> Answer:
        if (asked.method, asked.path) == ("GET", "/v1/models"):
            return self.models
        if (asked.method, asked.path) != ("POST", "/v1/chat/completions"):
            self.unscripted.append(f"{asked.method} {asked.path}")
            return saying({"error": {"message": "not found", "type": "NotFoundError", "param": None, "code": 404}}, status=404)
        asked_so_far = len(self.completions)
        if not self._scripted:
            self.unscripted.append(f"generation {asked_so_far}")
            return saying(
                {"error": {"message": "the stand-in has no reply scripted", "type": "InternalServerError", "param": None, "code": 500}},
                status=500,
            )
        scripted = self._scripted.pop(0)
        if isinstance(scripted, Answer):
            return scripted
        reply: JsonObject = {
            "id": f"chatcmpl-played-{asked_so_far}",
            "object": "chat.completion",
            "created": 1_760_000_000,
            "model": asked.json()["model"],
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": scripted.content, **scripted.beside},
                    "finish_reason": scripted.finish_reason,
                }
            ],
        }
        if scripted.usage is not None:
            reply["usage"] = scripted.usage
        return saying(reply)


# ── an interpreter of its own ───────────────────────────────────────────


def alone(program: str, *arguments: str) -> str:
    """What `program` printed, run by an interpreter of its own and given `arguments`."""
    ran = subprocess.run([sys.executable, "-c", program, *arguments], capture_output=True, text=True, check=False)
    assert ran.returncode == 0, ran.stderr
    return ran.stdout
