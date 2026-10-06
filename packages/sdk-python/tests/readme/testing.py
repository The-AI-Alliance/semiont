from semiont.client import SemiontClient
from semiont.identifiers import ResourceId
from semiont.testing import create_test_client
from semiont.transport import Transport


async def title_of(client: SemiontClient[Transport], resource: ResourceId) -> str:
    return (await client.browse.resource(resource).fresh()).name.title()


async def a_title_is_its_resources_name_in_title_case() -> None:
    made = create_test_client()
    made.transport.queue_reply(
        "browse:resource-requested",
        [
            {
                "resource": {"@context": "https://schema.org", "@id": "res-1", "name": "a page of notes", "representations": []},
                "annotations": [],
                "entityReferences": [],
            }
        ],
    )

    async with made.client as client:
        assert await title_of(client, ResourceId("res-1")) == "A Page Of Notes"

    # What the code under test asked of the knowledge base, as it was sent.
    assert [(asked.channel, asked.payload) for asked in made.transport.request_log] == [
        ("browse:resource-requested", {"resourceId": "res-1"})
    ]
    await made.transport.close()
