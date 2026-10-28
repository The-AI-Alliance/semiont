"""The Voyage provider, against a Voyage this test plays over HTTP: the call it makes, and how what Voyage says is read.

Nothing here asks the real Voyage. The stand-in is written from Voyage's API
reference (https://docs.voyageai.com/reference/embeddings-api), and so is
every answer a case scripts.

What the provider shares with the Ollama provider is held for both in one
place: cutting a batch, taking turns, a request's time and what a failure
says in `test_slices.py`, and measuring how wide a vector is in
`test_dimensions.py`.
"""

import asyncio

import httpx
import pytest
from aio import run, soon
from provider import KEY, MOST_TEXTS, Answer, Voyage, always, items, listed, saying, wait_out
from pydantic import JsonValue

from semiont_vectors.embedding import BatchPolicy, EmbeddingProviderError, SliceRef
from semiont_vectors.voyage import VOYAGE_BATCH_POLICY, VoyageEmbeddingProvider

MODEL = "voyage-3"
VECTOR: JsonValue = [0.1, 0.2]


def item(index: JsonValue, embedding: JsonValue) -> JsonValue:
    """One item of an answer's `data`, as the reference states one: whatever is given as its place and as its vector."""
    return {"object": "embedding", "embedding": embedding, "index": index}


def test_a_request_is_one_post_of_the_model_and_the_texts_with_the_key_as_a_bearer_token() -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            provider = VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint)
            assert await provider.embed_documents(["a", "bc"]) == [[1.0, 0.1], [2.0, 0.1]]
            (asked,) = voyage.asked
            assert (asked.method, asked.path) == ("POST", "/v1/embeddings")
            # The texts are documents, and nothing else the reference allows in a request is sent.
            assert asked.json() == {"model": MODEL, "input": ["a", "bc"], "input_type": "document"}
            assert (asked.headers["authorization"], asked.headers["content-type"]) == (f"Bearer {KEY}", "application/json")

    run(scenario())


def test_a_query_is_sent_as_a_query_and_documents_as_documents_and_a_request_has_no_other_member() -> None:
    # The reference says to state which a text is: Voyage makes another vector of the same words for each.
    async def scenario() -> None:
        async with Voyage() as voyage:
            provider = VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint)
            await provider.embed_query("a")
            await provider.embed_documents(["b", "c"])
            assert [(asked.texts, asked.input_type) for asked in voyage.asked] == [(["a"], "query"), (["b", "c"], "document")]
            assert [sorted(asked.json()) for asked in voyage.asked] == [["input", "input_type", "model"]] * 2

    run(scenario())


def test_a_batch_of_more_texts_than_one_request_may_carry_is_answered_since_no_request_carries_more_than_128() -> None:
    assert BatchPolicy(slice_size=128, concurrency=4) == VOYAGE_BATCH_POLICY

    async def scenario() -> None:
        async with Voyage() as voyage:
            texts = [f"chunk {number}" for number in range(MOST_TEXTS + 130)]
            provider = VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint)
            assert len(await provider.embed_documents(texts)) == len(texts)
            assert sorted(len(carried) for carried in voyage.inputs) == [106, *[128] * 8]
            assert voyage.most_at_once <= 4

    run(scenario())


def test_the_stand_in_refuses_what_voyages_reference_says_voyage_refuses() -> None:
    # The driver sends neither of these, so they are sent here by hand. A stand-in that took them would show
    # nothing by answering a batch that was cut into requests, or a request that carried the key.
    async def scenario() -> None:
        async with Voyage() as voyage, httpx.AsyncClient(trust_env=False) as http:
            keyed = {"Authorization": f"Bearer {KEY}"}
            most = await http.post(voyage.endpoint, headers=keyed, json={"model": MODEL, "input": ["a"] * MOST_TEXTS})
            too_many = await http.post(voyage.endpoint, headers=keyed, json={"model": MODEL, "input": ["a"] * (MOST_TEXTS + 1)})
            unkeyed = await http.post(voyage.endpoint, json={"model": MODEL, "input": ["a"]})
            assert (most.status_code, too_many.status_code, unkeyed.status_code) == (200, 400, 401)

    run(scenario())


def test_each_vector_is_put_at_its_index_whatever_order_voyage_lists_the_items_in() -> None:
    # The reference gives every item its `index` and does not say the items are in the order of the texts.
    async def scenario() -> None:
        async with Voyage() as voyage:
            vectors = [[1.0, 0.0], [2.0, 0.0], [3.0, 0.0]]
            data = items(vectors)
            data.reverse()
            voyage.script(listed(data))
            provider = VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint)
            assert await provider.embed_documents(["a", "b", "c"]) == vectors

    run(scenario())


def test_a_vector_is_read_as_floats_whether_voyage_wrote_its_numbers_whole_or_not() -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            voyage.script(listed([item(0, [1, 0, -2, 0.5])]))
            vector = await VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint).embed_query("a")
            assert vector == [1.0, 0.0, -2.0, 0.5]
            assert {type(number) for number in vector} == {float}

    run(scenario())


@pytest.mark.parametrize(
    "said",
    [
        Answer(body=b"<html>busy</html>"),
        saying([item(0, VECTOR), item(1, VECTOR)]),
        saying({"object": "list", "model": MODEL}),
        saying({"object": "list", "data": "none"}),
        listed([{"object": "embedding", "embedding": VECTOR}, item(1, VECTOR)]),
        listed([{"object": "embedding", "index": 0}, item(1, VECTOR)]),
        listed([item("0", VECTOR), item(1, VECTOR)]),
        listed([item(0, ["a", "b"]), item(1, VECTOR)]),
        listed([item(0, VECTOR)]),
        listed([item(0, VECTOR), item(1, VECTOR), item(2, VECTOR)]),
        listed([item(0, VECTOR), item(0, VECTOR)]),
        listed([item(0, VECTOR), item(2, VECTOR)]),
        listed([item(0, VECTOR), item(1, [])]),
    ],
    ids=[
        "not JSON",
        "not an object",
        "no data",
        "data that is no list",
        "an item with no index",
        "an item with no vector",
        "an index that is text",
        "a vector of text",
        "an item too few",
        "an item too many",
        "one index twice",
        "an index of no text that was sent",
        "a vector of no numbers",
    ],
)
def test_an_answer_that_does_not_hold_a_vector_for_each_text_is_a_failure_and_no_vector_is_made_of_it(said: Answer) -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            voyage.script(said)
            with pytest.raises(EmbeddingProviderError) as unread:
                await VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint).embed_documents(["a", "b"])
            failure = unread.value
            # An answer came, and the answer is what is wrong: its status is the failure's.
            assert (failure.provider, failure.status, failure.reached, failure.model) == ("voyage", 200, True, MODEL)
            assert failure.slice == SliceRef(index=0, start=0, end=2)
            assert isinstance(failure.__cause__, ValueError)

    run(scenario())


# The statuses Voyage's reference lists for a request it does not answer with vectors.
@pytest.mark.parametrize("status", [400, 401, 403, 429, 500, 502, 503, 504])
def test_a_refusal_is_a_failure_that_has_its_status_and_what_voyage_said(status: int) -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            voyage.script(Answer(status=status, body=b"error body"))
            with pytest.raises(EmbeddingProviderError) as refused:
                await VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint).embed_query("a")
            failure = refused.value
            assert (failure.provider, failure.model) == ("voyage", MODEL)
            assert (failure.status, failure.reached, failure.body) == (status, True, "error body")
            # The status is in the message too, so that a line of a log reads by itself.
            assert str(status) in str(failure)
            # Asked once: a query is not asked again, whatever the refusal.
            assert len(voyage.asked) == 1

    run(scenario())


# The two statuses of the reference's list that are taken to say Voyage is busy.
@pytest.mark.parametrize("status", [429, 503])
def test_a_voyage_that_stays_busy_is_asked_for_documents_four_times_and_the_failure_is_its_last_answer(status: int) -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            voyage.rule = always(Answer(status=status, body=b"busy"))
            provider = VoyageEmbeddingProvider(model=MODEL, api_key=KEY, endpoint=voyage.endpoint)
            embedding = asyncio.ensure_future(provider.embed_documents(["a"]))
            await wait_out(voyage, [1.0, 2.0, 4.0])
            with pytest.raises(EmbeddingProviderError) as busy:
                await soon(embedding)
            failure = busy.value
            assert (failure.provider, failure.model) == ("voyage", MODEL)
            assert (failure.status, failure.reached, failure.body) == (status, True, "busy")
            assert len(voyage.asked) == 4

    run(scenario())


def test_a_key_voyage_does_not_take_is_a_401() -> None:
    async def scenario() -> None:
        async with Voyage() as voyage:
            with pytest.raises(EmbeddingProviderError) as refused:
                await VoyageEmbeddingProvider(model=MODEL, api_key="another-key", endpoint=voyage.endpoint).embed_query("a")
            assert (refused.value.status, refused.value.reached) == (401, True)
            assert voyage.asked[0].headers["authorization"] == "Bearer another-key"

    run(scenario())
