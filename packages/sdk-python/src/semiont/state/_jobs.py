"""What the units that follow a job say of how it ended."""

from semiont.errors import JobError, SemiontError

__all__ = ["cancelled"]


def cancelled(error: SemiontError) -> bool:
    """Whether a job ended because it was cancelled: its commits stand, and its display stays to say so."""
    return isinstance(error, JobError) and error.code == "job.cancelled"
