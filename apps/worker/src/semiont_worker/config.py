"""The worker's configuration document, and what its environment holds beside it.

The document is the protocol's `WorkerConfig`. Whoever starts the worker
writes it, resolved: the launcher for the worker it starts, and anyone else
to the same schema. So it is read and refused here, and nothing is decided:
no TOML is parsed, no `${VAR}` resolved, and no value supplied that the
document left out. A secret is never in the document. The document names the
variable that holds it, and the environment is read here.

A refusal is worded as the gateway's, the Dispatcher's and the Archivist's
are, so an operator reads one kind of message from every service. It names a
member and what was expected of it, and never a value found in the document:
a key written where its variable's name belongs is such a value.
`docs/protocol/WORKER-SERVICE.md` § Configuration states each.
"""

from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Final, final

from pydantic import ValidationError
from semiont.http import Credential
from semiont.types import WorkerConfig


@final
class Refused(Exception):
    """Why the service does not start. Its words are what it says, once, before it exits."""


def config_path_of(arguments: Sequence[str]) -> str:
    """The path the worker was started with: what follows `--config`, or is joined to it by `=`.

    It is never guessed. A path the worker assumed would hide a deployment
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
    raise Refused("The worker's configuration document is not named: start it with --config <path>")


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


def read_worker_config(path: str) -> WorkerConfig:
    """The document at `path`: read, and held to its schema before it is believed.

    The schema is held as it is written. A member is known by the name the
    document gives it and by no other, and a value is the kind the schema
    states: a number written as text is no number.
    """
    try:
        written = Path(path).read_bytes()
    except OSError as unread:
        raise Refused(
            f"Cannot read the worker's configuration document at {path} ({unread}). "
            "The launcher writes it; a worker started another way is given one (WorkerConfig in specs/)."
        ) from unread
    try:
        return WorkerConfig.model_validate_json(written, strict=True, by_alias=True, by_name=False)
    except ValidationError as refused:
        refusals = refused.errors(include_url=False, include_input=False)
        for refusal in refusals:
            if refusal["type"] == "json_invalid":
                raise Refused(f"{path} is not JSON: {refusal['msg'].removeprefix('Invalid JSON: ')}") from None
        # Each reason on a line of its own.
        reasons = "\n".join(f"  {_reason(refusal['loc'], refusal['type'], refusal['msg'])}" for refusal in refusals)
        raise Refused(f"{path} is not a worker configuration document (WorkerConfig):\n{reasons}") from None


def api_key_of(config: WorkerConfig, index: int, environment: Mapping[str, str]) -> str | None:
    """The key of the agent at `index`, read from the variable the document names for it.

    An agent whose provider takes no key names no variable and has none. The
    refusal says which member named the variable and never what it named.
    """
    name = config.agents[index].api_key_env
    if name is None:
        return None
    key = set_in(environment, name)
    if key is None:
        raise Refused(f"agents[{index}].apiKeyEnv names a variable that is not set in the worker's environment")
    return key


def set_in(environment: Mapping[str, str], name: str) -> str | None:
    """What `environment` holds for the variable `name`. `None` where it holds nothing: a variable set to nothing is not set."""
    return environment.get(name) or None


def service_account_of(config: WorkerConfig, environment: Mapping[str, str]) -> Credential:
    """The worker's own account at the issuer the document names."""

    def held(name: str) -> str:
        value = set_in(environment, name)
        if value is None:
            raise Refused(f"{name} is not set in the worker's environment: a worker signs in as a service account")
        return value

    return Credential(
        issuer=config.identity.issuer, client_id=held("SEMIONT_OIDC_CLIENT_ID"), client_secret=held("SEMIONT_OIDC_CLIENT_SECRET")
    )
