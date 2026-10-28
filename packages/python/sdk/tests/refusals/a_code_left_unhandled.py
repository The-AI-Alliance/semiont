"""A vocabulary is closed: a `match` over one names every member."""

from typing import assert_never

from semiont.error_codes import JobErrorCode


def said(code: JobErrorCode) -> str:
    match code:
        case "job.failed":
            return "the job failed"
        case _:
            assert_never(code)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
