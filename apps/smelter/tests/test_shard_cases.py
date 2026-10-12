"""Where a key is filed, held to `specs/src/archivist/shard-cases.json`.

The table is the one every reader and writer of the sharded files runs, in
any language. The Archivist finds an entry of the anchored-text store where
this package filed it only while both work out the same two names.
"""

import pytest
from spec import ROOT, JsonObject, objects, read, text

from semiont_smelter.shard import shard_path

TABLE = read(ROOT / "specs/src/archivist/shard-cases.json")
CASES = objects(TABLE["cases"], "cases")


def test_the_table_is_its_rule_and_its_cases() -> None:
    assert set(TABLE) == {"$comment", "cases"}
    assert len(CASES) > 10
    for case in CASES:
        assert set(case) == {"why", "key", "shard"}, case
    whys = [text(case["why"], "why") for case in CASES]
    assert len(set(whys)) == len(whys)


@pytest.mark.parametrize("case", CASES, ids=[text(case["why"], "why") for case in CASES])
def test_a_key_is_filed_where_the_table_says(case: JsonObject) -> None:
    ab, cd = shard_path(text(case["key"], "key"))
    assert case["shard"] == f"{ab}/{cd}"


def test_a_key_whose_hash_is_the_least_integer_of_32_bits_is_filed_under_the_first_shard() -> None:
    # The table has no such key. These five units hash to 2 to the 31st, which kept as a signed integer of 32 bits is
    # the one that has no positive counterpart among them. Its absolute value is a multiple of the number of shards.
    units = (2324, 39, 60, 40, 95)
    hashed = 0
    for unit in units:
        hashed = hashed * 31 + unit
    assert hashed == 2**31
    assert shard_path("".join(chr(unit) for unit in units)) == ("00", "00")
