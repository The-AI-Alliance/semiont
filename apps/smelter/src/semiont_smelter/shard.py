"""Where a key is filed: the two directory names an entry of the anchored-text store is kept under.

The arithmetic is the one every reader and writer of these files shares, in
any language. `specs/src/archivist/shard-cases.json` states it, and the tests
run every case of that table.
"""

from typing import Final

__all__ = ["shard_path"]

_SHARDS: Final = 65536
"""How many shards there are: one for each value of four hex digits."""


def _shard(key: str) -> int:
    """A key's shard, of `_SHARDS`.

    Computed over the key's UTF-16 code units: start at 0; for each unit,
    multiply by 31 and add the unit, keeping the low 32 bits as a signed
    integer; take the absolute value; take it modulo the number of shards.
    """
    units = key.encode("utf-16-le")
    low = 0
    for at in range(0, len(units), 2):
        # An integer here grows and never wraps, so the low 32 bits are cut out at each step: they are all the next step reads.
        low = (low * 31 + int.from_bytes(units[at : at + 2], "little")) & 0xFFFFFFFF
    signed = low - (1 << 32) if low >= 1 << 31 else low
    # The least signed integer of 32 bits has no positive counterpart among them. Its absolute value here is 2 to the
    # 31st all the same, which is a multiple of the number of shards.
    return abs(signed) % _SHARDS


def shard_path(key: str) -> tuple[str, str]:
    """The two directory names a key is filed under: its shard as four lowercase hex digits, split in two."""
    digits = f"{_shard(key):04x}"
    return digits[:2], digits[2:]
