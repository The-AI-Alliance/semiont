"""How a Smelter reads the number of points its index holds, for the gauge that reports it (`docs/protocol/SMELTER.md` § Telemetry)."""

import logging

import pytest
from aio import run
from semiont.identifiers import AnnotationId, ResourceId
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.store import AnnotationPayload, EmbeddingChunk

from semiont_smelter.telemetry import points_held


def test_the_points_its_index_holds_are_read_as_the_index_counts_them_of_resources_and_of_annotations_together() -> None:
    async def scenario() -> int | None:
        index = MemoryVectorStore()
        chunks = [EmbeddingChunk(chunk_index=at, text=f"chunk {at}", embedding=[1.0, 0.0]) for at in (0, 1)]
        await index.upsert_resource_vectors(ResourceId("res-1"), chunks, "a-checksum", [], machine_read=False, media_type="text/plain")
        quoted = AnnotationPayload(
            annotation_id=AnnotationId("ann-1"),
            resource_id=ResourceId("res-1"),
            motivation="highlighting",
            entity_types=[],
            exact_text="chunk",
        )
        await index.upsert_annotation_vector([0.0, 1.0], quoted)
        return await points_held(index)

    assert run(scenario()) == 3


def test_a_count_the_index_fails_to_give_is_no_number_and_is_logged_once_as_a_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    index = MemoryVectorStore()

    async def refusing() -> int:
        raise ConnectionError("the database did not answer")

    monkeypatch.setattr(index, "count", refusing)

    with caplog.at_level(logging.WARNING, logger="semiont_smelter"):
        assert run(points_held(index)) is None
    (said,) = [record for record in caplog.records if record.name == "semiont_smelter"]
    assert said.levelno == logging.WARNING
    assert dict(vars(said))["error"] == "ConnectionError: the database did not answer"
