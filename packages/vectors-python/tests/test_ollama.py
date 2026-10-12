"""The Ollama provider, against an Ollama this test plays over HTTP: the call it makes, and how what Ollama says is read.

What it shares with the Voyage provider is held for both in one place:
cutting a batch, taking turns, a request's time and what a failure says in
`test_slices.py`, and measuring how wide a vector is in `test_dimensions.py`.
"""

import pytest
from aio import run
from provider import NOT_FETCHED, Answer, Ollama, saying

from semiont_vectors.embedding import BatchPolicy, EmbeddingProviderError, SliceRef
from semiont_vectors.ollama import OLLAMA_BATCH_POLICY, OllamaEmbeddingProvider

MODEL = "nomic-embed-text"


def test_a_request_is_one_post_of_the_model_and_the_texts_and_of_nothing_else() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            # Slashes at the end of the address are not part of it.
            provider = OllamaEmbeddingProvider(model=MODEL, base_url=ollama.origin + "//")
            assert await provider.embed_batch(["a", "bc"]) == [[1.0, 0.1], [2.0, 0.1]]
            (asked,) = ollama.asked
            assert (asked.method, asked.path) == ("POST", "/api/embed")
            assert asked.json() == {"model": MODEL, "input": ["a", "bc"]}
            assert asked.headers["content-type"] == "application/json"

    run(scenario())


def test_an_ollama_is_asked_128_texts_in_a_request_and_one_request_at_a_time_in_the_order_of_the_texts() -> None:
    assert BatchPolicy(slice_size=128, concurrency=1) == OLLAMA_BATCH_POLICY

    async def scenario() -> None:
        async with Ollama() as ollama:
            texts = [f"t{number}" for number in range(300)]
            assert len(await OllamaEmbeddingProvider(model=MODEL, base_url=ollama.origin).embed_batch(texts)) == 300
            assert ollama.inputs == [texts[:128], texts[128:256], texts[256:]]
            assert ollama.most_at_once == 1

    run(scenario())


def test_a_vector_is_read_as_floats_whether_ollama_wrote_its_numbers_whole_or_not() -> None:
    # A number with no fraction is written without one: `0` and `1` are numbers of a vector as `0.5` is.
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(saying({"embeddings": [[1, 0, -2, 0.5], [3, 0.25, 0.001, 4]]}))
            vectors = await OllamaEmbeddingProvider(model=MODEL, base_url=ollama.origin).embed_batch(["a", "b"])
            assert vectors == [[1.0, 0.0, -2.0, 0.5], [3.0, 0.25, 0.001, 4.0]]
            assert {type(number) for vector in vectors for number in vector} == {float}

    run(scenario())


@pytest.mark.parametrize(
    "said",
    [
        Answer(body=b"<html>busy</html>"),
        saying([[0.1, 0.2]]),
        saying({"model": MODEL}),
        saying({"embeddings": "none"}),
        saying({"embeddings": [["a", "b"]]}),
        saying({"embeddings": []}),
        saying({"embeddings": [[0.1], [0.2]]}),
        saying({"embeddings": [[]]}),
    ],
    ids=[
        "not JSON",
        "not an object",
        "no embeddings",
        "embeddings that are no list",
        "a vector of text",
        "no vector",
        "a vector too many",
        "a vector of no numbers",
    ],
)
def test_an_answer_that_does_not_hold_a_vector_for_each_text_is_a_failure_and_no_vector_is_made_of_it(said: Answer) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(said)
            with pytest.raises(EmbeddingProviderError) as unread:
                await OllamaEmbeddingProvider(model=MODEL, base_url=ollama.origin).embed("a")
            failure = unread.value
            # An answer came, and the answer is what is wrong: its status is the failure's.
            assert (failure.provider, failure.status, failure.reached, failure.model) == ("ollama", 200, True, MODEL)
            assert failure.slice == SliceRef(index=0, start=0, end=1)
            assert isinstance(failure.__cause__, ValueError)

    run(scenario())


@pytest.mark.parametrize("status", [400, 404, 429, 500, 503])
def test_a_refusal_is_a_failure_that_has_its_status_and_what_ollama_said(status: int) -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(Answer(status=status, body=b"error body"))
            with pytest.raises(EmbeddingProviderError) as refused:
                await OllamaEmbeddingProvider(model=MODEL, base_url=ollama.origin).embed("a")
            failure = refused.value
            assert (failure.provider, failure.model) == ("ollama", MODEL)
            assert (failure.status, failure.reached, failure.body) == (status, True, "error body")
            # The status is in the message too, so that a line of a log reads by itself.
            assert str(status) in str(failure)
            # Asked once: a refusal is not asked again by the driver.
            assert len(ollama.asked) == 1

    run(scenario())


def test_a_model_ollama_does_not_have_is_a_404_and_the_model_is_on_the_failure_whatever_ollama_said() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.script(NOT_FETCHED)
            with pytest.raises(EmbeddingProviderError) as absent:
                await OllamaEmbeddingProvider(model="another-model", base_url=ollama.origin).embed("a")
            # Nothing that handles the failure reads the model out of what the provider said, which names another.
            assert (absent.value.status, absent.value.model) == (404, "another-model")
            assert "not found" in absent.value.body

    run(scenario())
