"""The stamp an index is held to when a Smelter starts: what it states, and what becomes of an index that states another or none."""

import logging

import pytest
from aio import run
from semiont.identifiers import ResourceId
from semiont.types import SmelterConfig
from semiont_vectors.memory import MemoryVectorStore
from semiont_vectors.store import EmbeddingChunk, IndexStamp

from semiont_smelter.index_stamp import hold_to, stamp_of

STAMP: IndexStamp = {"embedding": {"type": "ollama", "model": "nomic-embed-text"}, "chunking": {"chunkSize": 512, "overlap": 64}}
OTHER_MODEL: IndexStamp = {"embedding": {"type": "ollama", "model": "all-minilm"}, "chunking": {"chunkSize": 512, "overlap": 64}}
OTHER_CUT: IndexStamp = {"embedding": {"type": "ollama", "model": "nomic-embed-text"}, "chunking": {"chunkSize": 256, "overlap": 64}}


def configured(embedding: dict[str, str], chunk_size: int, overlap: int) -> SmelterConfig:
    """A Smelter's document, with this embedding provider and these two numbers."""
    return SmelterConfig.model_validate(
        {
            "gatewayUrl": "http://127.0.0.1:1",
            "identity": {"issuer": "http://127.0.0.1:1/realms/semiont"},
            "archivist": {"host": "127.0.0.1", "port": 1},
            "embedding": embedding,
            "vectors": {"type": "qdrant", "host": "127.0.0.1", "port": 1},
            "chunking": {"chunkSize": chunk_size, "overlap": overlap},
            "pdfsAtOnce": 1,
            "port": 24101,
            "logLevel": "warn",
            "logFormat": "simple",
        }
    )


async def with_a_point(stamp: IndexStamp | None) -> MemoryVectorStore:
    """A connected index that holds one resource's point, made anew with `stamp` first where one is given."""
    index = MemoryVectorStore()
    await index.connect()
    if stamp is not None:
        await index.make_anew(stamp)
    chunk = EmbeddingChunk(chunk_index=0, text="a text", embedding=[1.0, 0.0])
    await index.upsert_resource_vectors(ResourceId("res-1"), [chunk], "5f" * 32, [], machine_read=False, media_type="text/markdown")
    return index


def test_a_stamp_states_the_provider_s_type_its_model_and_the_two_numbers_a_text_is_cut_by() -> None:
    ollama = {"type": "ollama", "model": "nomic-embed-text", "baseUrl": "http://127.0.0.1:1"}
    assert stamp_of(configured(ollama, 512, 64)) == STAMP
    # Where the model is served is no part of it: the same model served elsewhere makes the same vectors.
    assert stamp_of(configured({**ollama, "baseUrl": "http://ollama.example:11434"}, 512, 64)) == STAMP
    assert stamp_of(configured({**ollama, "model": "all-minilm"}, 512, 64)) == OTHER_MODEL
    assert stamp_of(configured(ollama, 256, 64)) == OTHER_CUT
    # A model of the same name from another provider is another model.
    voyage = {"type": "voyage", "model": "nomic-embed-text", "endpoint": "http://127.0.0.1:1/v1/embeddings", "apiKeyEnv": "VOYAGE_API_KEY"}
    assert stamp_of(configured(voyage, 512, 64)) != STAMP


def test_an_index_that_states_the_smelter_s_stamp_is_left_as_it_is() -> None:
    async def scenario() -> None:
        index = await with_a_point(STAMP)

        assert await hold_to(index, STAMP) is False

        assert await index.count() == 1
        assert await index.index_stamp() == STAMP

    run(scenario())


@pytest.mark.parametrize("stated", [OTHER_MODEL, OTHER_CUT, None], ids=["another model", "another cut", "no stamp"])
def test_an_index_that_states_another_stamp_or_none_is_made_again_empty_and_a_warning_says_so(
    stated: IndexStamp | None, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        index = await with_a_point(stated)

        assert await hold_to(index, STAMP) is True

        # Every point it held was of another model, another cut, or of nobody knows what.
        assert await index.count() == 0
        assert await index.index_stamp() == STAMP

    with caplog.at_level(logging.INFO, logger="semiont_smelter"):
        run(scenario())
    (said,) = [record for record in caplog.records if record.name == "semiont_smelter"]
    assert said.levelno == logging.WARNING
    assert (vars(said)["stated"], vars(said)["stamp"]) == (stated, STAMP)


def test_an_index_that_holds_nothing_and_states_nothing_is_stamped_and_no_warning_is_logged(caplog: pytest.LogCaptureFixture) -> None:
    async def scenario() -> None:
        index = MemoryVectorStore()
        await index.connect()

        assert await hold_to(index, STAMP) is True

        assert await index.index_stamp() == STAMP

    with caplog.at_level(logging.INFO, logger="semiont_smelter"):
        run(scenario())
    assert [record.levelno for record in caplog.records if record.name == "semiont_smelter"] == [logging.INFO]
