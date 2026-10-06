"""What a channel of the bus is, to a type checker and at run time."""

from dataclasses import dataclass
from typing import Protocol, final

from pydantic import JsonValue

from semiont.model import WireModel

__all__ = ["AnyChannel", "AnyOperation", "Channel", "Empty", "Operation", "Response"]


@final
class Empty(WireModel, frozen=True, extra="forbid"):
    """The payload of a channel that carries none: the empty object."""


@final
class Response[T](WireModel, frozen=True):
    """The payload of a reply that wraps what it answers with: `{ response }`."""

    response: T


class AnyChannel(Protocol):
    """A channel, whatever it carries: what code that treats every channel alike reads of one."""

    @property
    def name(self) -> str: ...

    @property
    def payload(self) -> type[WireModel]: ...

    def decode(self, value: JsonValue) -> WireModel: ...


@final
@dataclass(frozen=True, slots=True)
class Channel[P: WireModel]:
    """A channel's name, and the type of the payload it carries.

    `payload` is `P` itself, so the two cannot be written to disagree: a
    `Channel[A]` built with the class `B` does not type-check. And a channel is
    its own payload's and no other's: a `Channel[A]` is not a `Channel[B]`,
    whatever `A` and `B` are to each other, so a function that takes a channel
    and a payload is refused a payload that is another channel's.
    """

    name: str
    payload: type[P]

    def decode(self, value: JsonValue) -> P:
        """What a frame on this channel carries, as its payload's type. Raises `ValidationError` for anything else."""
        return self.payload.model_validate(value)

    def encode(self, payload: P) -> JsonValue:
        """`payload` as the wire carries it: by the wire's names, and without what was never said."""
        return payload.model_dump(mode="json", exclude_unset=True)


class AnyOperation(Protocol):
    """An operation, whatever it asks and answers."""

    @property
    def request(self) -> AnyChannel: ...

    @property
    def result(self) -> AnyChannel: ...

    @property
    def failure(self) -> AnyChannel: ...


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Operation[Request: WireModel, Result: WireModel, Failure: WireModel]:
    """A request, and the two channels it is answered on."""

    request: Channel[Request]
    result: Channel[Result]
    failure: Channel[Failure]
