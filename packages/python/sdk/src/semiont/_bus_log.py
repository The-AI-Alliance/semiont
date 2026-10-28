"""The bus log: with `SEMIONT_BUS_LOG` set, a line on stdout for each frame a transport sends or receives, each read and each upload.

    [bus EMIT] mark:create-request scope=res-1 cid=a89a670a trace=8f3ca4ed {"resourceId":"res-1"}

Every Semiont SDK writes it, in one form, so that the lines of several
processes read as one timeline (`docs/protocol/EVENT-BUS.md` § Wire format).
A line is what was sent or asked for, written when it is: the frame's
channel, or `content` for a read or an upload; the resource's scope, the
first eight characters of the correlation id, and the first eight of the id
of the trace the line was written in, each where there is one; and the
payload, as JSON.

Set is any value that is not empty. The variable is read once, when the
first line would be written, and it is the one environment variable this
package reads.

No line holds a credential. The value of a member whose whole name is one a
credential goes by (`token`, which is what the spec names the token a
resource is cloned by, and the rest of `_CREDENTIALS` below) is not written,
wherever in a payload it is: `[withheld]` is written in its place, as every
bus log writes it (`specs/src/bus/log-cases.json`).
"""

import json
import os
from collections.abc import Mapping
from functools import cache
from typing import Final, Literal

from pydantic import JsonValue

from semiont import telemetry
from semiont.identifiers import ResourceId

_WITHHELD: Final = "[withheld]"
"""What a line says in place of a credential."""

_CREDENTIALS: Final = frozenset(
    {
        "token",
        "cloneToken",
        "accessToken",
        "access_token",
        "refreshToken",
        "refresh_token",
        "apiKey",
        "api_key",
        "clientSecret",
        "client_secret",
        "secret",
        "password",
        "authorization",
        "Authorization",
        "x-api-key",
        "x-goog-api-key",
    }
)
"""The names of the members whose value is one.

The list `specs/src/bus/log-cases.json` states for every bus log, which this
package's tests hold this one to.
"""


@cache
def enabled() -> bool:
    """Whether the bus log is written: what the process's environment said when this was first asked."""
    return bool(os.environ.get("SEMIONT_BUS_LOG"))


def _shown(value: JsonValue) -> JsonValue:
    """A payload as a line shows it: as it is, less the value of each credential."""
    if isinstance(value, dict):
        return {name: _WITHHELD if name in _CREDENTIALS else _shown(member) for name, member in value.items()}
    if isinstance(value, list):
        return [_shown(item) for item in value]
    return value


def bus_note(op: Literal["LINGER"], channel: str, note: str) -> None:
    """Write a line about a channel that is no frame: `[bus <op>] <channel> <note>`."""
    if enabled():
        print(f"[bus {op}] {channel} {note}", flush=True)


def bus_log(
    op: Literal["EMIT", "RECV", "PUT", "GET"],
    channel: str,
    payload: Mapping[str, JsonValue],
    *,
    scope: ResourceId | None = None,
    correlation_id: str | None = None,
) -> None:
    """Write the line of one frame sent or received, or of one read or upload of content."""
    if not enabled():
        return
    said = f"[bus {op}] {channel}"
    if scope:
        said += f" scope={scope}"
    if correlation_id:
        said += f" cid={correlation_id[:8]}"
    within = telemetry.active()
    if within is not None:
        # A trace context's second field is the trace's id.
        said += f" trace={within.traceparent.split('-')[1][:8]}"
    print(f"{said} {json.dumps(_shown(dict(payload)), ensure_ascii=False, separators=(',', ':'))}", flush=True)
