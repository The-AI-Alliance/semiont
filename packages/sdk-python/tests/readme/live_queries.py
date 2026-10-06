from typing import assert_never

from semiont.cache import Failed, Pending, Ready
from semiont.client import SemiontClient
from semiont.identifiers import ResourceId
from semiont.transport import Transport


async def watch(client: SemiontClient[Transport], resource: ResourceId) -> None:
    async with client.browse.annotations(resource) as live:  # holds the resource's scope
        async for state in live:
            match state:
                case Pending():
                    print("asking")
                case Ready(value=annotations):
                    print(len(annotations), "annotations")
                case Failed(error=error):  # a state, not a raise: the query lives on
                    print("failed:", error.code)
                case _:
                    assert_never(state)
