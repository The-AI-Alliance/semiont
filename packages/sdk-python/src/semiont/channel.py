"""What a channel of the bus is, to a type checker and at run time."""

from dataclasses import dataclass, field
from types import UnionType
from typing import Annotated, Protocol, TypeAliasType, Union, final, get_args, get_origin

from pydantic import JsonValue, TypeAdapter

from semiont.model import WireModel, written

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
    def payload(self) -> type[WireModel] | TypeAliasType: ...

    @property
    def members(self) -> tuple[type[WireModel], ...]: ...

    def decode(self, value: JsonValue) -> WireModel: ...


def _members(payload: object) -> tuple[type[WireModel], ...]:
    """The shapes a payload's type names: itself, or each member of the union it names."""
    if isinstance(payload, type) and issubclass(payload, WireModel):
        return (payload,)
    if isinstance(payload, TypeAliasType):
        return _members(payload.__value__)
    if get_origin(payload) is Annotated:
        return _members(get_args(payload)[0])
    if get_origin(payload) in (Union, UnionType):
        return tuple(member for part in get_args(payload) for member in _members(part))
    raise TypeError(f"{payload!r} is not a shape of the protocol, nor a union of them")


def _stamps(member: type[WireModel]) -> frozenset[str]:
    """The names beginning `_` that a shape declares, as the wire has them."""
    return frozenset(wire for name, stated in member.model_fields.items() if (wire := stated.alias or name).startswith("_"))


@final
@dataclass(frozen=True, slots=True)
class Channel[P: WireModel]:
    """A channel's name, and the type of the payload it carries.

    `payload` is `P` itself, so the two cannot be written to disagree: a
    `Channel[A]` built with the class `B` does not type-check. And a channel is
    its own payload's and no other's: a `Channel[A]` is not a `Channel[B]`,
    whatever `A` and `B` are to each other, so a function that takes a channel
    and a payload is refused a payload that is another channel's.

    A payload is one shape, or one of several: `P` is then their union, and
    `payload` the name `semiont.types` gives it. A frame is decoded to the
    member it names, and any member is written. What a name stands for is not a
    type checker's to compare with `P`: a name that is no union of shapes is
    refused when the channel is made, and the channels of the registry are held
    to its schemas by this package's tests.
    """

    name: str
    payload: type[P] | TypeAliasType
    members: tuple[type[WireModel], ...] = field(init=False, repr=False, compare=False)
    """The shapes a frame on it is decoded to: its payload's one, or each member of the union its payload is."""
    stamps: frozenset[str] = field(init=False, repr=False, compare=False)
    """What the gateway stamps on a frame that is the payload's own: the names beginning `_` that its type declares."""
    _adapter: TypeAdapter[P] = field(init=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        members = _members(self.payload)
        declared = {member.__name__: _stamps(member) for member in members}
        stamps = frozenset[str]().union(*declared.values())
        if any(of_one != stamps for of_one in declared.values()):
            # A stamp is kept or dropped before the frame is read, and so before it is known which member the frame is.
            said = "; ".join(f"{name} declares {sorted(of_one)}" for name, of_one in declared.items())
            raise TypeError(
                f"{self.name}: its shapes do not declare the same stamps ({said}). Write how a frame's are read by the member it names."
            )
        object.__setattr__(self, "members", members)
        object.__setattr__(self, "stamps", stamps)
        object.__setattr__(self, "_adapter", TypeAdapter[P](self.payload))

    def decode(self, value: JsonValue) -> P:
        """What a frame on this channel carries, as its payload's type. Raises `ValidationError` for anything else."""
        return self._adapter.validate_python(value)

    def encode(self, payload: P) -> dict[str, JsonValue]:
        """`payload` as the wire carries it (`semiont.model.written`)."""
        return written(payload)


class AnyOperation(Protocol):
    """An operation, whatever it asks and answers."""

    @property
    def request(self) -> AnyChannel: ...

    @property
    def result(self) -> AnyChannel: ...

    @property
    def failure(self) -> AnyChannel: ...

    @property
    def reply_names(self) -> tuple[str, ...]: ...


@final
@dataclass(frozen=True, slots=True, kw_only=True)
class Operation[Request: WireModel, Result: WireModel, Failure: WireModel]:
    """A request, and the two channels it is answered on."""

    request: Channel[Request]
    result: Channel[Result]
    failure: Channel[Failure]

    @property
    def reply_names(self) -> tuple[str, ...]:
        """What the reply states beside its `response`, by the names the wire gives them.

        Each is a property of the request, which a gateway states again in its
        reply: the id it answers for. Nothing, for most operations.
        """
        answers = self.result.members
        if len(answers) != 1:
            raise TypeError(f"{self.result.name} answers with one of several shapes. Write what such a reply states beside its response.")
        stated = answers[0].model_fields.items()
        return tuple(wire for name, said in stated if said.is_required() and (wire := said.alias or name) != "response")
