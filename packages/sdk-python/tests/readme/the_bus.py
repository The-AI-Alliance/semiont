from semiont.bus import Bus
from semiont.channels import MARK_ADDED
from semiont.errors import BusRequestError
from semiont.http import HttpTransport
from semiont.identifiers import ResourceId
from semiont.operations import BROWSE_RESOURCE_REQUESTED
from semiont.types import BrowseResourceRequest
from semiont.watched import Variable


async def read(origin: str, token: str, resource: ResourceId) -> None:
    async with HttpTransport(origin, token=Variable[str | None](token)) as transport:
        bus = Bus(transport)
        try:
            reply = await bus.request(BROWSE_RESOURCE_REQUESTED, BrowseResourceRequest(resource_id=resource))
        except BusRequestError as error:
            print(error.code)  # "bus.not-found", "bus.timeout", …: a closed vocabulary
            return
        print(reply.response.resource.name)

        # Frames arrive on a resource's channels while its scope is held.
        with transport.subscribe_to_resource(resource):
            async with bus.frames(MARK_ADDED) as added:
                async for frame in added:
                    print(frame.scope, frame.payload.type)
