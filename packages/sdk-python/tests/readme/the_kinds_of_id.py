from semiont.identifiers import AnnotationId, InvalidIdentifier, ResourceId
from semiont.types import MarkDeleteCommand

resource = ResourceId("5bcd259ab1464cf68a556bbad21f513f")
assert ResourceId.parse("not an id") is None  # where text that is not an id is an ordinary answer
try:
    ResourceId("https://kb.example/resources/x")
except InvalidIdentifier as refused:
    print(refused)  # 'https://kb.example/resources/x' is not a ResourceId: it does not match ^[A-Za-z0-9_-]{1,128}$

command = MarkDeleteCommand(annotation_id=AnnotationId("a-1"), resource_id=resource)
print(command.model_dump(mode="json", exclude_unset=True))
# {'annotationId': 'a-1', 'resourceId': '5bcd259ab1464cf68a556bbad21f513f'}

# MarkDeleteCommand(annotation_id=resource) is refused by a type checker: a ResourceId is not an AnnotationId.
