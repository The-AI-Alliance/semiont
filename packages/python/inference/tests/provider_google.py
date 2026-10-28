"""Google's Gemini API, played: the two calls the Google driver makes through Google's library, answered from what a test scripted.

`GET /v1beta/models/{model}` is answered with `model`, a model's resource as
the Developer API states one. `POST /v1beta/models/{model}:generateContent`
is answered with the next reply a test scripted, in the JSON the API writes:
camel case, a count left out where it is nothing.

A request nothing was scripted for, and a request of any other path, lands in
`unscripted`, which fails the test on the way out.
"""

from dataclasses import dataclass
from typing import final, override

from provider import Answer, Asked, Played, saying
from spec import JsonObject

API = "/v1beta/models/"


def _retrieves(asked: Asked) -> bool:
    return asked.method == "GET" and asked.path.startswith(API)


def _generates(asked: Asked) -> bool:
    return asked.method == "POST" and asked.path.startswith(API) and asked.path.endswith(":generateContent")


def google_error(status: int, word: str, message: str) -> Answer:
    """A refusal as Google's API states one: the status, Google's word for it, and what it says of it."""
    return saying({"error": {"code": status, "message": message, "status": word}}, status=status)


def gemini_model(*, input_token_limit: int | None = 1_048_576, output_token_limit: int | None = 65_536) -> Answer:
    """What `models.get` answers for one model. A limit is stated only when given."""
    resource: JsonObject = {
        "name": "models/gemini-played",
        "version": "001",
        "displayName": "Gemini, played",
        "description": "A model this test plays.",
        "supportedGenerationMethods": ["generateContent", "countTokens"],
        "temperature": 1,
        "maxTemperature": 2,
        "topP": 0.95,
        "topK": 64,
        "thinking": True,
    }
    if input_token_limit is not None:
        resource["inputTokenLimit"] = input_token_limit
    if output_token_limit is not None:
        resource["outputTokenLimit"] = output_token_limit
    return saying(resource)


def text_part(text: str, *, thought: bool = False) -> JsonObject:
    """One part of a candidate's content: text of the answer, or, marked so, a summary of what the model thought."""
    return {"text": text, "thought": True} if thought else {"text": text}


def said(*parts: JsonObject) -> JsonObject:
    """A candidate's content: what the model wrote, in parts."""
    return {"role": "model", "parts": [*parts]}


def candidate(content: JsonObject | None, *, finish_reason: str | None = "STOP", finish_message: str | None = None) -> JsonObject:
    """One candidate of a reply. With `content` None it has no content at all; a reason and a message are stated only when given."""
    made: JsonObject = {"index": 0}
    if content is not None:
        made["content"] = content
    if finish_reason is not None:
        made["finishReason"] = finish_reason
    if finish_message is not None:
        made["finishMessage"] = finish_message
    return made


def counted(prompt: int | None, answer: int | None, thoughts: int | None = None) -> JsonObject:
    """A reply's `usageMetadata`. A count is stated only when given, as the API leaves out one that is nothing."""
    usage: JsonObject = {}
    if prompt is not None:
        usage["promptTokenCount"] = prompt
    if answer is not None:
        usage["candidatesTokenCount"] = answer
    if thoughts is not None:
        usage["thoughtsTokenCount"] = thoughts
    usage["totalTokenCount"] = (prompt or 0) + (answer or 0) + (thoughts or 0)
    return usage


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Generated:
    """What `generateContent` answers with: its candidates, what the provider counted, and what it says of the prompt.

    Each is stated only when given: a reply to a prompt the provider blocked
    has no `candidates` member at all.
    """

    candidates: list[JsonObject] | None
    usage: JsonObject | None
    prompt_feedback: JsonObject | None = None


def generated(text: str, *, finish_reason: str | None = "STOP", usage: JsonObject | None = None) -> Generated:
    """A reply of one candidate that holds `text`. With no `usage` given it reports ten tokens read and five written."""
    return Generated(
        candidates=[candidate(said(text_part(text)), finish_reason=finish_reason)], usage=counted(10, 5) if usage is None else usage
    )


def blocked(reason: str) -> Generated:
    """A reply to a prompt the provider blocked before any candidate: the reason, and no candidates."""
    return Generated(candidates=None, usage=counted(10, None), prompt_feedback={"blockReason": reason})


@final
class Google(Played):
    """A stand-in for the Gemini Developer API. `model` is what `models.get` answers; `script` queues the replies of the next generations.

    A driver is given `origin`: the address a config names is the API's
    root, and the library adds the version of the API to it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.model: Answer = gemini_model()
        self._scripted: list[Generated | Answer] = []

    def script(self, *replies: Generated | Answer) -> None:
        """What the next generations are answered with, in order, after those already scripted."""
        self._scripted.extend(replies)

    @staticmethod
    def generation(model: str) -> str:
        """The path a generation by `model` is asked at."""
        return f"{API}{model}:generateContent"

    @property
    def retrievals(self) -> list[Asked]:
        """Every request of `models.get`, in order."""
        return [asked for asked in self.asked if _retrieves(asked)]

    @property
    def generating(self) -> list[Asked]:
        """Every request of `generateContent`, in order."""
        return [asked for asked in self.asked if _generates(asked)]

    @property
    def generations(self) -> list[JsonObject]:
        """The body of every generation, in order."""
        return [asked.json() for asked in self.generating]

    @override
    def _answer(self, asked: Asked) -> Answer:
        if _retrieves(asked):
            return self.model
        if not _generates(asked):
            self.unscripted.append(f"{asked.method} {asked.path}")
            return google_error(404, "NOT_FOUND", "the stand-in has nothing at this path")
        asked_so_far = len(self.generating)
        if not self._scripted:
            self.unscripted.append(f"generation {asked_so_far}")
            return google_error(500, "INTERNAL", "the stand-in has no reply scripted")
        scripted = self._scripted.pop(0)
        if isinstance(scripted, Answer):
            return scripted
        reply: JsonObject = {"modelVersion": "gemini-played-001", "responseId": f"resp_played_{asked_so_far}"}
        if scripted.candidates is not None:
            reply["candidates"] = [*scripted.candidates]
        if scripted.prompt_feedback is not None:
            reply["promptFeedback"] = scripted.prompt_feedback
        if scripted.usage is not None:
            reply["usageMetadata"] = scripted.usage
        return saying(reply)
