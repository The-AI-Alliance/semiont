"""A service's configuration document, and what its environment holds beside it.

The document is a shape of the protocol: `WorkerConfig`, `WeaverConfig`,
`SmelterConfig`.
Whoever starts the service writes it, resolved: the launcher for the service
it starts, and anyone else to the same schema. So it is read and refused
here, and nothing is decided: no TOML is parsed, no `${VAR}` resolved, and no
value supplied that the document left out. A secret is never in the document.
The document names the variable that holds it, and the service reads its
environment for it.

A refusal is worded as the gateway's, the Dispatcher's and the Archivist's
are, so an operator reads one kind of message from every service: it names
the service in lower case, as its image and its container are named. It names
a member and what was expected of it, and never a value found in the
document: a secret written where its variable's name belongs is such a value.
"""

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final, final

from pydantic import ValidationError
from semiont.http import SecretCredential
from semiont.model import WireModel

__all__ = ["Refused", "config_path_of", "read_config", "service_account_of", "set_in"]


@final
class Refused(Exception):
    """Why the service does not start. Its words are what it says, once, before it exits."""


def config_path_of(service: str, arguments: Sequence[str]) -> str:
    """The path the service was started with: what follows `--config`, or is joined to it by `=`.

    It is never guessed. A path the service assumed would hide a deployment
    that put the document somewhere else.
    """
    for at, argument in enumerate(arguments):
        if argument.startswith("--config="):
            path = argument.removeprefix("--config=")
            if path:
                return path
        elif argument == "--config" and at + 1 < len(arguments):
            path = arguments[at + 1]
            if path and not path.startswith("--"):
                return path
    raise Refused(f"The {service}'s configuration document is not named: start it with --config <path>")


_STATES_WHAT_WAS_EXPECTED: Final = frozenset(
    {
        "bool_type",
        "dict_type",
        "greater_than_equal",
        "int_from_float",
        "int_type",
        "less_than_equal",
        "list_type",
        "literal_error",
        "model_type",
        "string_too_short",
        "string_type",
        "too_short",
        "union_tag_not_found",
    }
)
"""The refusals whose own words say what was expected of a member, and nothing of what was found there.

Any other refusal is said by its kind alone: its words are the validator's,
and some of them repeat what the document held.
"""


def _member(location: Sequence[int | str]) -> str:
    """A member of the document, as the document's own names reach it: `agents[0].accepts`. The document itself is `root`."""
    path = ""
    for step in location:
        path += f"[{step}]" if isinstance(step, int) else f".{step}" if path else step
    return path or "root"


def _reason(location: Sequence[int | str], kind: str, said: str) -> str:
    """One refusal of the schema's, as a line an operator reads: where it is, what kind it is, and the validator's words for it."""
    if kind == "missing":
        return f"Missing required property: {location[-1]}"
    if kind == "extra_forbidden":
        return f"{_member(location[:-1])}: unknown property {location[-1]}"
    if kind in _STATES_WHAT_WAS_EXPECTED:
        return f"{_member(location)}: {said}"
    return f"{_member(location)}: is not what the schema states ({kind})"


def read_config[C: WireModel](service: str, shape: type[C], path: str) -> C:
    """The document at `path`, as the shape of the protocol that `shape` is: read, and held to its schema before it is believed.

    The schema is held as it is written. A member is known by the name the
    document gives it and by no other, and a value is the kind the schema
    states: a number written as text is no number.
    """
    try:
        written = Path(path).read_bytes()
    except OSError as unread:
        raise Refused(
            f"Cannot read the {service}'s configuration document at {path} ({unread}). "
            f"The launcher writes it; a {service} started another way is given one ({shape.__name__} in specs/)."
        ) from unread
    try:
        return shape.model_validate_json(written, strict=True, by_alias=True, by_name=False)
    except ValidationError as refused:
        refusals = refused.errors(include_url=False, include_input=False)
        for refusal in refusals:
            if refusal["type"] == "json_invalid":
                raise Refused(f"{path} is not JSON: {refusal['msg'].removeprefix('Invalid JSON: ')}") from None
        # Each reason on a line of its own.
        reasons = "\n".join(f"  {_reason(refusal['loc'], refusal['type'], refusal['msg'])}" for refusal in refusals)
        raise Refused(f"{path} is not a {service} configuration document ({shape.__name__}):\n{reasons}") from None


def set_in(environment: Mapping[str, str], name: str) -> str | None:
    """What `environment` holds for the variable `name`. `None` where it holds nothing: a variable set to nothing is not set."""
    return environment.get(name) or None


def service_account_of(service: str, issuer: str, environment: Mapping[str, str]) -> SecretCredential:
    """The service's own account at `issuer`, which its document names."""

    def held(name: str) -> str:
        value = set_in(environment, name)
        if value is None:
            raise Refused(f"{name} is not set in the {service}'s environment: a {service} signs in as a service account")
        return value

    return SecretCredential(issuer=issuer, client_id=held("SEMIONT_OIDC_CLIENT_ID"), client_secret=held("SEMIONT_OIDC_CLIENT_SECRET"))
