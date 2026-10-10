"""Which `mark` job a holder was handed.

The spec states a `mark` job's description, one shape for each motivation,
and what the Dispatcher adds to the params of a job it holds: the resource
the job is about and, for a tagging job, the schema its `schemaId` names. It
leaves the held shape open. So whoever holds a job asks here which of the
five it was handed, and is answered the description as the spec's shape for
its motivation.
"""

from dataclasses import dataclass
from typing import Final, final

from pydantic import TypeAdapter, ValidationError
from semiont.model import written
from semiont.types import (
    AssessingJobParams,
    CommentingJobParams,
    HighlightingJobParams,
    JobParams,
    LinkingJobParams,
    MarkJobParams,
    TaggingJobParams,
    TagSchema,
)


@final
@dataclass(frozen=True, slots=True)
class HeldTagging:
    """A tagging job as its holder is handed it: its description, and the schema its `schema_id` names, as the Dispatcher resolved it."""

    params: TaggingJobParams
    schema: TagSchema


type HeldMark = HighlightingJobParams | CommentingJobParams | AssessingJobParams | LinkingJobParams | HeldTagging
"""A `mark` job as its holder is handed it, of one of the five motivations."""

_DESCRIPTION: Final = TypeAdapter[MarkJobParams](MarkJobParams)
_ADDED: Final = frozenset(field.alias or name for name, field in JobParams.model_fields.items())
"""What the Dispatcher adds to a job's params, by the names the wire gives them."""
_NO_SUCH_MOTIVATION: Final = frozenset({"union_tag_invalid", "union_tag_not_found"})
"""How the description's shape refuses params that state none of its motivations."""


def held_mark(params: JobParams) -> HeldMark | None:
    """The `mark` job `params` are, or `None` where they are none this holder can run.

    They are none where they state no motivation of a `mark` job, as a
    `yield` job's do not, and where they are a tagging job's without the
    schema the Dispatcher resolves: a `schemaId` alone names a schema this
    holder cannot read.

    Raises `pydantic.ValidationError` for params that state a motivation and
    are not its shape. They are refused, and not taken for another job.
    """
    stated = {name: value for name, value in written(params).items() if name not in _ADDED}
    try:
        description = _DESCRIPTION.validate_python(stated)
    except ValidationError as refused:
        if all(error["type"] in _NO_SUCH_MOTIVATION for error in refused.errors()):
            return None
        raise
    if isinstance(description, TaggingJobParams):
        return None if params.schema_ is None else HeldTagging(params=description, schema=params.schema_)
    return description
