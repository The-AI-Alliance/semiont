"""The reasoning efforts a model catalogue names, in their order, and the least of those a model's facts name.

A driver that is to ask for the least reasoning has to know which effort is
the least. A catalogue names a model's efforts and does not always list them
from least to most, so their order is stated here, once, for every driver
that sends one.
"""

from semiont_inference.catalogue import CatalogueFacts, EffortOption, ReasoningEffort


def _rank(effort: ReasoningEffort) -> int:
    """Where an effort stands, from the least reasoning to the most."""
    match effort:
        case "none":
            return 0
        case "minimal":
            return 1
        case "low":
            return 2
        case "medium":
            return 3
        case "high":
            return 4
        case "xhigh":
            return 5
        case "max":
            return 6


def least_effort(facts: CatalogueFacts) -> ReasoningEffort | None:
    """The least reasoning effort the model's facts name, or None where they name none.

    Only a way of setting reasoning by a named effort is read. A way of
    another kind (a toggle, a budget of tokens) names no effort.
    """
    named: list[ReasoningEffort] = [
        effort for option in facts.reasoning_options or () if isinstance(option, EffortOption) for effort in option.values
    ]
    return min(named, key=_rank, default=None)
