from semiont.client import SemiontClient
from semiont.identifiers import ResourceId
from semiont.transport import PutBinaryRequest, Transport
from semiont.types import GenerationJobParams, JobDeclinedResult, LinkingJobParams


async def summarize(client: SemiontClient[Transport], paper: bytes) -> ResourceId | None:
    # Ingest: the paper's bytes become a resource.
    created = await client.yield_.resource(
        PutBinaryRequest(
            name="Attention Is All You Need",
            file=paper,
            format="application/pdf",
            storage_uri="file://papers/attention-is-all-you-need.pdf",
        )
    )
    paper_id = created.resource_id

    # Annotate: a model reads it and marks each mention of a concept.
    await client.mark.delegate(paper_id, LinkingJobParams(motivation="linking", entity_types=["Concept"]))

    # Gather: the paper, its annotations, and what the knowledge base holds around it.
    context = await client.gather.resource(paper_id)

    # Generate: a new resource, grounded in that context and linked to its source.
    done = await client.yield_.delegate(
        GenerationJobParams(
            title="Attention Is All You Need: a summary",
            storage_uri="file://generated/attention-summary.md",
            context=context,
            task="summary",
        )
    )
    # What a `yield` job reports is the resource it made. One that could not read what it was given declines, and makes nothing.
    made = done.result
    return None if made is None or isinstance(made, JobDeclinedResult) else made.resource_id
