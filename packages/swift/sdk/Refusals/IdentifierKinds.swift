// refused: cannot convert value of type 'AnnotationId' to expected argument type 'ResourceId'
import Semiont

func resource(_ value: ResourceId) {}
resource(try AnnotationId("annotation-one"))
