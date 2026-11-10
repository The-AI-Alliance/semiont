"""What a registry's session says, told the registry: its errors' one reader, which each `SessionFactory` runs (`semiont.registry`)."""

import asyncio

from semiont.errors import SessionError, TransportError
from semiont.registry import SessionFactoryOptions
from semiont.session import SemiontSession
from semiont.transport import Transport


async def tell[T: Transport](session: SemiontSession[T], options: SessionFactoryOptions) -> None:
    """Tell the registry what `session` says, read from its errors from the moment it is held until they end.

    Each of its own errors is told `options.on_error`, what it said as it
    started among them. A refusal for want of a valid token renews the
    session: it heals quietly, or the session ends itself and says so once. A
    refusal for lack of permission has no remedy, and is said
    (`options.signals`). A renewal still under way when the errors end ends
    with them, and one that failed is raised then.
    """
    renewals: list[asyncio.Task[str | None]] = []
    errors = session.errors()
    try:
        async with errors:
            async for error in errors:
                if isinstance(error, SessionError):
                    options.on_error(error)
                elif isinstance(error, TransportError):
                    match error.code:
                        case "unauthorized":
                            # Refusals that arrive together are answered by one renewal: the session holds them while it renews.
                            # A failure does not say which token was refused: the one the session holds as it is read is.
                            renewals.append(asyncio.create_task(session.refresh(session.token.value)))
                        case "forbidden":
                            options.signals.notify_permission_denied(error.message)
                        case _:
                            pass
    finally:
        for renewal in renewals:
            renewal.cancel()
        ended = await asyncio.gather(*renewals, return_exceptions=True)
    for outcome in ended:
        if isinstance(outcome, Exception):
            raise outcome
