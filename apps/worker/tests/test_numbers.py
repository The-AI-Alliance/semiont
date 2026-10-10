"""A number said in a prompt, written as the suite's prompts have one: a whole number with no fraction, any other by its fewest digits."""

import math

import pytest

from semiont_worker.numbers import as_javascript_writes


@pytest.mark.parametrize(
    ("number", "written"),
    [
        (5.0, "5"),
        (0.0, "0"),
        (-0.0, "0"),
        (-3.0, "-3"),
        (2.5, "2.5"),
        (-2.5, "-2.5"),
        (0.1, "0.1"),
        (4.35, "4.35"),
        (123456789.125, "123456789.125"),
        # Python's own writing takes an exponent from sixteen digits up, and under one part in ten thousand.
        (1e16, "10000000000000000"),
        (1.5e16, "15000000000000000"),
        (0.000123, "0.000123"),
        (0.00001, "0.00001"),
        (1e-6, "0.000001"),
        # Where JavaScript's begins: at twenty-two digits, and under one part in a million.
        (1e20, "100000000000000000000"),
        (123456789012345680000.0, "123456789012345680000"),
        (1e21, "1e+21"),
        (1.2345e25, "1.2345e+25"),
        (1e-7, "1e-7"),
        (1.5e-7, "1.5e-7"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
    ],
)
def test_a_number_is_written_as_javascript_writes_it(number: float, written: str) -> None:
    assert as_javascript_writes(number) == written


@pytest.mark.parametrize("number", [math.inf, -math.inf, math.nan])
def test_what_is_no_finite_number_is_refused(number: float) -> None:
    with pytest.raises(ValueError, match="finite"):
        as_javascript_writes(number)
