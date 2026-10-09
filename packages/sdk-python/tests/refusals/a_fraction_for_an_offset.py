"""An offset is a whole number: a fraction is neither where a span starts nor where it ends."""

from semiont.annotations import TextSpan


def as_a_start() -> TextSpan:
    return TextSpan(start=0.5, end=12, exact="Ada Lovelace")  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


def as_an_end() -> TextSpan:
    return TextSpan(start=0, end=11.5, exact="Ada Lovelace")  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
