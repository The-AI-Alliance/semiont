// refused: 'val' cannot be reassigned
// A model is what was read or made: it is not changed in place.
import semiont.identifiers.AnnotationId
import semiont.types.MarkDeleteCommand

fun reassign(command: MarkDeleteCommand) {
    command.annotationId = AnnotationId("ann-2")
}
