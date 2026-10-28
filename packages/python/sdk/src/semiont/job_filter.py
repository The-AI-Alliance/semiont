"""Whether a job matches a filter.

A filter (`JobFilter`) is a partial job description: it names fields of the
description at the description's own paths. A job matches when every field
the filter states equals the job's; what the filter leaves out is not
compared. So the comparison knows no field by name, and does not change when
a filter may state another.

It is asked in two places: by the dispatcher, choosing the next job a claim
takes, and by a party checking an announcement (`job:queued`) against its own
claim before it asks. specs/src/jobs/filter-cases.json holds every
implementation to one answer, and this package's tests run it.
"""

from collections.abc import Mapping

from pydantic import JsonValue

__all__ = ["job_matches_filter"]


def _states(stated: JsonValue, actual: JsonValue) -> bool:
    """Whether `actual` states everything `stated` does, at the same paths."""
    if isinstance(stated, Mapping):
        return isinstance(actual, Mapping) and all(name in actual and _states(value, actual[name]) for name, value in stated.items())
    # A number is the number it is, however it was written: 1 and 1.0 are one value, and neither is `true`.
    if isinstance(stated, bool) or isinstance(actual, bool):
        return stated is actual
    return stated == actual


def job_matches_filter(job_filter: Mapping[str, JsonValue], job: Mapping[str, JsonValue]) -> bool:
    """Whether `job` matches `job_filter`.

    Both are as the wire carries them: a filter as a claim states it, and a
    job description as it is announced or held, with its `jobType` and its
    `params`.
    """
    return _states(dict(job_filter), dict(job))
