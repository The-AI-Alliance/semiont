// refused: argument type mismatch: actual type is 'ResourceId', but 'AnnotationId' was expected
// One kind of id is not another.
import semiont.identifiers.ResourceId
import semiont.types.MarkDeleteCommand

val command = MarkDeleteCommand(annotationId = ResourceId("res-1"))
