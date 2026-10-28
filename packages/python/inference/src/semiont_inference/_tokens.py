"""The tokens a provider says a generation cost: read from its reply, and answered as a usage. Every driver counts them this way."""

from pydantic import JsonValue

from semiont_inference.interface import TokenUsage

type Counts = tuple[int | None, int | None]
"""The tokens a provider says it read and wrote, each where it said so."""


def count(value: JsonValue) -> int | None:
    """A count of tokens, where `value` is one."""
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def read_counts(stated: JsonValue, read: str, written: str) -> Counts:
    """The two counts a provider's reply states in `stated`, under the provider's own names for what it read and what it wrote.

    Each is None where the reply does not state it, and both are where
    `stated` is not an object. Where in a reply the counts are, and what they
    are called, is each provider's, and is said by its driver.
    """
    if not isinstance(stated, dict):
        return None, None
    return count(stated.get(read)), count(stated.get(written))


def as_usage(counts: Counts) -> TokenUsage | None:
    """The provider's two counts as a usage, or None where it did not report both.

    Never a zero in a count's place: that would say the call cost nothing,
    which is another claim than not knowing.
    """
    input_tokens, output_tokens = counts
    return None if input_tokens is None or output_tokens is None else TokenUsage(input_tokens=input_tokens, output_tokens=output_tokens)
