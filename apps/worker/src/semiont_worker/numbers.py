"""A number written into a prompt.

A job states a number as JSON does, and the SDK's params hold it as a float:
a density of 5 is 5.0 there. Python writes that as `5.0`, where the prompts
the worker service's suite holds a worker to say `5`: a number is written in
them as JavaScript writes one. So a number that goes into a prompt is
written by that rule, and by nothing a float was born with.
"""

import math


def as_javascript_writes(number: float) -> str:
    """`number` as JavaScript writes one: a whole number with no fraction, and any other by the fewest digits that read back as it.

    The digits are written out plainly for a number of up to twenty-one
    digits before its point, or of up to five zeros between its point and
    its first digit. Beyond either it is written with an exponent, `1e+21`
    and `1e-7`.

    Raises `ValueError` for what is no finite number: JSON states none, and
    so does no job.
    """
    if not math.isfinite(number):
        raise ValueError(f"{number} is no finite number")
    if number == 0:
        return "0"
    sign = "-" if number < 0 else ""
    # `repr` writes the fewest digits that read back as the number. They are taken apart into the digits
    # themselves and where the point stands among them: `point` digits are before it, and under one, zeros follow it.
    mantissa, _, exponent = repr(abs(number)).partition("e")
    whole, _, fraction = mantissa.partition(".")
    written = whole + fraction
    point = len(whole) + (int(exponent) if exponent else 0) - (len(written) - len(written.lstrip("0")))
    digits = written.strip("0")
    if len(digits) <= point <= 21:
        return f"{sign}{digits}{'0' * (point - len(digits))}"
    if 0 < point <= 21:
        return f"{sign}{digits[:point]}.{digits[point:]}"
    if -6 < point <= 0:
        return f"{sign}0.{'0' * -point}{digits}"
    power = point - 1
    return f"{sign}{digits[0]}{'.' + digits[1:] if len(digits) > 1 else ''}e{'+' if power >= 0 else '-'}{abs(power)}"
