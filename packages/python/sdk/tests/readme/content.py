from semiont.http import HttpTransport
from semiont.identifiers import ResourceId
from semiont.transport import PutBinaryRequest


async def store(transport: HttpTransport, page: bytes) -> ResourceId:
    upload = transport.content.put_binary(
        PutBinaryRequest(name="A page", file=page, format="text/markdown", storage_uri="file://pages/a.md", entity_types=["Note"])
    )
    async for progress in upload:
        print(progress.bytes_uploaded, "of", progress.total_bytes)
    created = await upload

    stored = await transport.content.get_binary(created.resource_id)
    assert (stored.data, stored.content_type) == (page, "text/markdown")
    async with await transport.content.get_binary_stream(created.resource_id) as arriving:
        async for piece in arriving:
            print(len(piece))

    me = await transport.get_current_user()
    print(me.did, (await transport.health_check()).status)
    return created.resource_id
