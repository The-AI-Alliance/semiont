"""The step that sizes the next piece of a text from what the last one cost.

A budget picks one opening size for every text from the provider's limits
alone. It cannot see the text, so it is sized for a dense one, and a sparse
text would pay for that in many small calls. The step moves the size as the
unit runs: a piece that left most of the output budget unused grows the next,
and one that came near the edge eases it off.

It steers one number, how full of the output budget a piece came in. Nothing
but a measured under-use grows a piece: no statistic of the text, and no
guess at its density. A piece that is cut off or runs out of time is asked
again in smaller pieces by the descent, and the next piece is cut at the size
the descent found to fit: one overflow teaches the walk what a dense stretch
needs. `specs/src/worker/chunk-plan-cases.json` holds the rule, as its `step`.
"""

import math
from dataclasses import dataclass
from typing import Final, Literal, final

type Recovered = int | Literal["uncut"]
"""What a descent recovered a piece at: the smallest size a piece it cut was cut at, among those it accepted, or `uncut`
where it accepted the piece it was handed, whose size it is not told."""


@final
@dataclass(frozen=True, slots=True)
class CallOutcome:
    """What one piece cost: all the step needs.

    `recovered` is what the descent recovered the piece at, where a call on
    it failed in a way a smaller piece can fix, and `None` where none did.
    It answers the next piece's size whatever was counted.

    `output_tokens` is what the provider counted over the piece's calls, and
    `None` where any call went uncounted. `None` is not zero: a provider that
    reports no usage would otherwise read as a piece that wrote nothing, and
    every piece would grow to the ceiling on no evidence.
    """

    recovered: Recovered | None
    output_tokens: int | None


@final
@dataclass(frozen=True, slots=True)
class SizingBounds:
    """How far the step may move a piece's size, in tokens, and the output budget a piece's use is measured against.

    They are worked out for one job from its provider's limits.
    """

    floor: int
    ceiling: int
    output_budget: int


@final
@dataclass(frozen=True, slots=True)
class ChunkSizingPolicy:
    """How hard a piece's size chases the measured use of the output budget.

    Under `grow_below` of the budget a piece left room, and the next grows by
    `grow_factor`. Over `shrink_above` it came near the edge, and the next
    shrinks by `shrink_factor`, which is also the step a resumed unit opens
    under its cursor's size by. Each step is a product, so that a sparse text
    reaches its ceiling in a few pieces and a wrong step costs one correction.
    """

    grow_below: float
    shrink_above: float
    grow_factor: float
    shrink_factor: float


CHUNK_SIZING_POLICY: Final = ChunkSizingPolicy(grow_below=0.5, shrink_above=0.8, grow_factor=1.5, shrink_factor=0.7)
"""The one policy in effect. It is coarse on purpose: the descent forgives a wrong step."""


def _inside(bounds: SizingBounds, size: int) -> int:
    return max(bounds.floor, min(bounds.ceiling, size))


def next_chunk_size(outcome: CallOutcome, current: int, bounds: SizingBounds) -> int:
    """The size of the next piece, from the size `current` the last piece was cut at and what it cost.

    A piece that size-failed answers what its descent recovered it at: the
    next piece is cut at that size, or at `current` where the descent accepted
    the piece uncut. Otherwise, with nothing counted, or with no output budget
    to measure a count against, the size holds. Otherwise the share of the
    budget used decides: the next piece grows, shrinks or holds. Each product
    is taken in floating point and rounded down. Whatever is answered is
    brought inside the bounds.
    """
    policy = CHUNK_SIZING_POLICY
    if outcome.recovered is not None:
        # `uncut`: the piece itself came back whole, at the size it was cut at.
        stepped = outcome.recovered if isinstance(outcome.recovered, int) else current
    elif outcome.output_tokens is None or bounds.output_budget <= 0:
        # Nothing measured moves nothing. A recovery above is evidence without a count; no count on its own is none.
        stepped = current
    else:
        used = outcome.output_tokens / bounds.output_budget
        if used < policy.grow_below:
            stepped = math.floor(current * policy.grow_factor)
        elif used > policy.shrink_above:
            stepped = math.floor(current * policy.shrink_factor)
        else:
            stepped = current
    return _inside(bounds, stepped)


def resumed_size(cursor_size: int, bounds: SizingBounds) -> int:
    """The size a resumed unit opens at: one shrink step under the size its cursor states, brought inside the bounds.

    A rule of its own, and not the step's: the attempt that wrote the cursor
    died and recovered nothing. The same size would cut the same piece and be
    answered the same way, and the opening size would throw away what that
    attempt learned.
    """
    return _inside(bounds, math.floor(cursor_size * CHUNK_SIZING_POLICY.shrink_factor))
