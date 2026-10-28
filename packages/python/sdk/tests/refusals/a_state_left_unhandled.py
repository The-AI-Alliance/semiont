"""A connection's states are closed: a `match` over one names every state."""

from typing import assert_never

from semiont.transport import ConnectionState


def delivers(state: ConnectionState) -> bool:
    match state:
        case "open":
            return True
        case "initial" | "connecting" | "reconnecting" | "degraded" | "unauthenticated":
            return False
        case _:
            assert_never(state)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
