"""Yield: creating resources, by upload, by a generation delegated as a job, and by cloning."""

from typing import Final, final

from semiont.channel import Empty
from semiont.channels import YIELD_CLONE
from semiont.identifiers import ResourceId
from semiont.media_types import clone_format, primary_media_type, storage_uri
from semiont.model import stated
from semiont.namespaces.follow import Delegation, follow
from semiont.namespaces.links import Links
from semiont.operations import YIELD_CLONE_RESOURCE_REQUESTED, YIELD_CLONE_TOKEN_REQUESTED
from semiont.timing import GENERATION_STALL_ASSUMED_TOKENS_COUNT, GENERATION_STALL_FLOOR_MS, GENERATION_STALL_PER_TOKEN_MS
from semiont.transport import ContentTransport, PutBinaryRequest, Upload
from semiont.types import (
    CloneResourceWithTokenResponse,
    CreateResourceResponse,
    GatheredContextFocusResource,
    GenerationJobParams,
    ResourceDescriptor,
    YieldCloneResourceRequest,
    YieldCloneTokenRequest,
    YieldJobCreateCommand,
)

__all__ = ["YieldNamespace", "generation_stall_deadline_ms"]


def generation_stall_deadline_ms(max_tokens: float | None) -> int:
    """How long a followed generation may say nothing before its follower gives up on it.

    A floor, and a wait that grows with the length asked for: a generation
    says nothing while its model writes, so the silence it is allowed depends
    on how much it was asked to write.
    """
    tokens = GENERATION_STALL_ASSUMED_TOKENS_COUNT if max_tokens is None else max(max_tokens, 0)
    return max(GENERATION_STALL_FLOOR_MS, round(GENERATION_STALL_PER_TOKEN_MS * tokens))


@final
class YieldNamespace:
    """See the module's documentation."""

    def __init__(self, links: Links, content: ContentTransport) -> None:
        self._links: Final = links
        self._content: Final = content

    def resource(self, data: PutBinaryRequest) -> Upload:
        """Upload bytes as a new resource: the upload's progress, and the resource created."""
        return self._content.put_binary(data)

    def delegate(self, params: GenerationJobParams, *, stall_deadline_ms: int | None = None) -> Delegation:
        """Delegate the making of a resource from a gathered context, as a `yield` job: its progress and its completion.

        The context's focus says what the job is about, so the job names no
        resource. An option of `params` given as `None` is an option not
        given. A follower that hears nothing for `stall_deadline_ms`, or for
        `generation_stall_deadline_ms(params.max_tokens)` when none is
        stated, asks for that job to be cancelled and ends as stalled.
        """
        focus = params.context.focus
        about = focus.resource.id if isinstance(focus, GatheredContextFocusResource) else focus.source_resource.id
        within = generation_stall_deadline_ms(params.max_tokens) if stall_deadline_ms is None else stall_deadline_ms
        create = YieldJobCreateCommand(job_type="yield", params=stated(params))
        return follow(self._links, create, resource_id=about, stall_ms=within)

    async def clone_token(self, resource_id: ResourceId) -> CloneResourceWithTokenResponse:
        """A token another resource can be created from: a clone of this one."""
        return (await self._links.request(YIELD_CLONE_TOKEN_REQUESTED, YieldCloneTokenRequest(resource_id=resource_id))).response

    async def from_token(self, token: str) -> ResourceDescriptor:
        """The resource a clone token was made from."""
        answer = await self._links.request(YIELD_CLONE_RESOURCE_REQUESTED, YieldCloneResourceRequest(token=token))
        return answer.response.source_resource

    async def create_from_token(
        self, *, token: str, name: str, content: str, archive_original: bool | None = None
    ) -> CreateResourceResponse:
        """Create a resource as a clone of the one `token` was made from.

        The source is read first. The clone's content then goes by the upload
        path, in the format its source's allows
        (`semiont.media_types.clone_format`) and under a name made from its
        own. `archive_original` archives the source once the clone exists.
        """
        source = await self.from_token(token)
        format_ = clone_format(primary_media_type(source))
        return await self._content.put_binary(
            PutBinaryRequest(
                name=name,
                file=content.encode(),
                format=format_.media_type,
                storage_uri=storage_uri(name, format_),
                clone_token=token,
                archive_original=archive_original,
            )
        )

    def clone(self) -> None:
        """Signal: a clone of the open resource is wanted."""
        self._links.signal(YIELD_CLONE, Empty())
