"""The mock: a provider that asks nobody, and answers a vector worked out from the text."""

import asyncio
import math

import pytest
from aio import run

from semiont_vectors.mock import MockEmbeddingProvider, deterministic_vector


def length(vector: list[float]) -> float:
    return math.sqrt(sum(number * number for number in vector))


def test_a_vector_is_as_wide_as_the_mock_was_told_and_of_length_one() -> None:
    async def scenario() -> None:
        provider = MockEmbeddingProvider(dimensions=8)
        vector = await provider.embed("hello world")
        assert len(vector) == 8
        assert length(vector) == pytest.approx(1.0)
        assert await provider.dimensions() == 8

    run(scenario())


def test_the_same_text_is_given_the_same_vector_and_another_text_another() -> None:
    async def scenario() -> None:
        provider = MockEmbeddingProvider(dimensions=8)
        assert await provider.embed("hello") == await provider.embed("hello")
        assert await provider.embed("hello") != await provider.embed("world")

    run(scenario())


def test_it_answers_the_vector_deterministic_vector_states_singly_and_in_a_batch() -> None:
    # A test states the vector it expects without asking the provider it is testing.
    async def scenario() -> None:
        provider = MockEmbeddingProvider(dimensions=8)
        assert await provider.embed("hello") == deterministic_vector("hello", 8)
        assert await provider.embed_batch(["a", "b", "c"]) == [deterministic_vector(text, 8) for text in ("a", "b", "c")]
        assert await provider.embed_batch([]) == []

    run(scenario())


def test_a_text_is_read_by_its_code_points() -> None:
    # Two code points. UTF-16 has two units for the first of them, and the second number is worked out from "a" all the same.
    raw = [math.sin(0x1F600) * 0.5, math.sin(ord("a") + 0.1) * 0.5]
    assert deterministic_vector("\U0001f600a", 2) == pytest.approx([number / math.hypot(*raw) for number in raw])


def test_no_more_of_a_text_is_read_than_as_many_code_points_as_the_vector_is_wide() -> None:
    assert deterministic_vector("hello world", 5) == deterministic_vector("hello there", 5)
    assert deterministic_vector("hello world", 8) != deterministic_vector("hello there", 8)
    # A text shorter than the vector is wide is read again from its first code point.
    assert deterministic_vector("ab", 4) == deterministic_vector("abab", 4)


def test_an_empty_text_is_given_the_vector_of_a_text_whose_code_points_are_0() -> None:
    assert deterministic_vector("", 3) == deterministic_vector("\x00", 3)
    assert length(deterministic_vector("", 3)) == pytest.approx(1.0)
    # At one dimension its one number is 0. Nothing of length one can be made of that, and it is answered as it is.
    assert deterministic_vector("", 1) == [0.0]


def test_a_call_gives_the_loop_a_turn_so_that_a_cancellation_lands_inside_it() -> None:
    # A real provider waits on a request. A mock that never waited could not be cancelled where a real one can.
    async def scenario() -> None:
        provider = MockEmbeddingProvider(dimensions=8)
        one = asyncio.ensure_future(provider.embed("hello"))
        many = asyncio.ensure_future(provider.embed_batch(["hello", "world"]))
        # One turn: each call has begun, and neither has ended.
        await asyncio.sleep(0)
        one.cancel()
        many.cancel()
        with pytest.raises(asyncio.CancelledError):
            await one
        with pytest.raises(asyncio.CancelledError):
            await many

    run(scenario())
