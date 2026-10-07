from semiont.client import SemiontClient
from semiont.identifiers import ResourceId
from semiont.namespaces.follow import JobCompleted
from semiont.namespaces.mark import MarkAssistOptions
from semiont.transport import PutBinaryRequest, Transport
from semiont.types import GenerationJobParams, JobGenerationResult


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
    await client.mark.assist(paper_id, "linking", MarkAssistOptions(entity_types=["Concept"]))

    # Gather: the paper, its annotations, and what the knowledge base holds around it.
    context = await client.gather.resource(paper_id)

    # Generate: a new resource, grounded in that context and linked to its source.
    done = await client.yield_.from_context(
        GenerationJobParams(
            title="Attention Is All You Need: a summary",
            storage_uri="file://generated/attention-summary.md",
            context=context,
            task="summary",
        )
    )
    if isinstance(done, JobCompleted) and isinstance(done.data.result, JobGenerationResult):
        return done.data.result.resource_id
    return None
