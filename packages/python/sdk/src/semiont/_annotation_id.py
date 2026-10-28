"""The id of an annotation a builder makes.

The id is not minted: it is worked out from what the annotation is, so the
same annotation built again, by any worker in any language, has the same id,
and writing it a second time changes nothing.
`specs/src/annotations/id-cases.json` holds the rule, for this and for every
other SDK.
"""

import base64
import hashlib
import json
from typing import Final

from pydantic import JsonValue

from semiont.identifiers import AnnotationId, ResourceId
from semiont.types import Motivation

_LENGTH: Final = 21
"""How many characters of the digest's base64url an id is."""


def _canonical(value: JsonValue) -> str:
    """`value` as canonical JSON: no white space, and an object's members in the order of their names by code point, at every depth.

    A `str` compares by code point, so sorting names is that order. A string
    is written as `json` writes one that is not held to ASCII: the escapes the
    rule states and no other.
    """
    match value:
        case None:
            return "null"
        case bool():
            return "true" if value else "false"
        case int():
            return str(value)
        case float():
            if not value.is_integer():
                raise ValueError(f"{value} is not a whole number, and the rule of an annotation's id states how no other is written")
            return str(int(value))
        case str():
            return json.dumps(value, ensure_ascii=False)
        case list():
            return f"[{','.join(_canonical(item) for item in value)}]"
        case dict():
            return f"{{{','.join(f'{_canonical(name)}:{_canonical(value[name])}' for name in sorted(value))}}}"


def annotation_id_for(resource_id: ResourceId, motivation: Motivation, anchor: str, body: JsonValue) -> AnnotationId:
    """The id of the annotation of `resource_id` that has this motivation, this anchor and this body.

    `anchor` says where on the resource the annotation is, and is empty for an
    annotation of the resource as a whole. `body` is the body as the wire
    carries it, and `None` for an annotation that has none: an annotation's
    body is never `null`.
    """
    identity: dict[str, JsonValue] = {"resourceId": resource_id, "motivation": motivation, "anchor": anchor}
    if body is not None:
        identity["body"] = body
    digest = hashlib.sha256(_canonical(identity).encode("utf-8")).digest()
    return AnnotationId(base64.urlsafe_b64encode(digest).decode("ascii")[:_LENGTH])
