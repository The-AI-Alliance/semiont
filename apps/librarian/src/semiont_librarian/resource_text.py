"""A resource's text, read where its media type says the text is, and the preview a search gives of it.

A resource's media type decides where its text comes from
(`docs/protocol/LIBRARIAN.md` § Gathering around an annotation, "A resource's
text is"): its bytes decoded, read from the Archivist, where its bytes are
its text; its anchored text, asked of the gateway, where its text is derived
from its bytes; and nothing where the type has no text
(`specs/src/media-types/registry.json`). A preview (§ Text search) is the
start of the text of a resource whose bytes are its text, and the empty
string for every other.

A cut counts Unicode code points.
"""

from typing import Final

from semiont.media_types import derives_text_of, text_source_of
from semiont.resources import decode_representation, primary_representation
from semiont.types import ExtractedText, ResourceDescriptor
from semiont_service.content import ContentReads

from semiont_librarian.reads import AnchoredText

__all__ = ["preview_of", "text_of"]

_PREVIEW_LENGTH: Final = 200
"""How many code points of a resource's text a preview is, at most."""


def _stored_media_type(resource: ResourceDescriptor) -> str | None:
    """The media type of a resource's stored bytes, read from its primary representation. `None` for a resource with no stored bytes.

    A resource with no representation has none, and neither has one whose
    representation states no `storageUri`.
    """
    primary = primary_representation(resource)
    if primary is None or not primary.storage_uri:
        return None
    return primary.media_type


async def text_of(resource: ResourceDescriptor, *, content: ContentReads, anchored: AnchoredText) -> str | None:
    """A resource's text. `None` where its media type has no text, where its derived text is not there, and where it has no stored bytes.

    A derived text that is not there yet, one the Smelter declined to
    derive, and one the gateway knows nothing of are each `None`, and never
    the empty text. A read of bytes that fails is raised
    (`semiont_service.content.ContentUnread`), and so is a text that cannot
    be decoded as the content type it was served with says.
    """
    media_type = _stored_media_type(resource)
    if media_type is None or text_source_of(media_type) == "none":
        return None
    if derives_text_of(media_type):
        answer = await anchored.ask(resource.id)
        return answer.text if isinstance(answer, ExtractedText) else None
    # The bytes are the text. They are decoded as the content type they were served with says.
    served = await content.read(resource.id)
    return decode_representation(served.data, served.content_type)


async def preview_of(resource: ResourceDescriptor, *, content: ContentReads) -> str:
    """The first 200 code points of the text of a resource whose bytes are its text, read once, by the resource's id.

    The empty string for every other resource, and no bytes are read: one
    with no stored bytes, one whose text is derived, and one that has no
    text. A read that fails previews as the empty string too.
    """
    media_type = _stored_media_type(resource)
    if media_type is None or derives_text_of(media_type) or text_source_of(media_type) == "none":
        return ""
    try:
        served = await content.read(resource.id)
        return decode_representation(served.data, served.content_type)[:_PREVIEW_LENGTH]
    except Exception:
        # A preview is beside an answer and is none itself: whatever kept it from being read, the resource is still found.
        return ""
