"""An emit carries a JSON object, on a resource's scope: not any object, and not any text."""

from datetime import UTC, datetime

from semiont.transport import Transport


async def emits(transport: Transport) -> None:
    await transport.emit("beckon:focus", {"at": datetime.now(tz=UTC)})  # type: ignore[dict-item]  # pyright: ignore[reportArgumentType]
    await transport.emit("beckon:focus", {}, scope="res-1")  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
