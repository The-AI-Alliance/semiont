"""A shape is built by its Python names; the wire's spelling is how it is written out."""

from semiont.identifiers import AnnotationId
from semiont.types import MarkDeleteCommand


def by_the_wire_s_name() -> MarkDeleteCommand:
    return MarkDeleteCommand(annotationId=AnnotationId("a-1"))  # type: ignore[call-arg]  # pyright: ignore[reportCallIssue]
