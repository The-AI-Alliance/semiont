"""A resource's id is not an annotation's, wherever one is wanted."""

from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import MarkDeleteCommand


def as_a_field(resource: ResourceId) -> MarkDeleteCommand:
    return MarkDeleteCommand(annotation_id=resource)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]


def as_a_result(resource: ResourceId) -> AnnotationId:
    return resource  # type: ignore[return-value]  # pyright: ignore[reportReturnType]


def as_an_argument(resource: ResourceId) -> None:
    def delete(annotation: AnnotationId) -> None: ...

    delete(resource)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
