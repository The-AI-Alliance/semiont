"""How wide a provider's vectors are: measured by asking the provider, once, and asked of a provider that may not be ready yet.

Each of the two providers is held to every case here, against a stand-in
that plays it over HTTP.
"""

import asyncio

import httpx
import pytest
from aio import hurried, pass_time, run, settle, soon
from provider import HANG_UP, HOLD, Answer, Ollama, Play, Voyage, always, told, unstarted

from semiont_vectors._dimensions import PROBE, resolve_dimensions
from semiont_vectors._retry import EMBEDDING_PROVIDER_RETRY
from semiont_vectors.embedding import EMBED_ROUND_TRIP_SECONDS, EmbeddingProviderError

MODEL = "a-model"
WIDTH = len(told(PROBE))
"""How wide the vector is that a stand-in answers when nothing else was said."""

ABSENT = Answer(status=404, body=b"no such model")
"""What a provider says of a model it does not have, which is also what one says of a model on its way."""

each_provider = pytest.mark.parametrize("play", [Ollama, Voyage], ids=["ollama", "voyage"])


# ── measuring ───────────────────────────────────────────────────────────


@each_provider
@pytest.mark.parametrize(("model", "width"), [("some-brand-new-model", 7), ("nomic-embed-text", 3), ("voyage-3", 5)])
def test_the_width_is_measured_by_asking_the_provider_for_one_vector(play: Play, model: str, width: int) -> None:
    # No table of models is kept. A model nobody has heard of is as wide as its vector is, and so is one everybody
    # knows: what the provider answers is what counts.
    async def scenario() -> None:
        async with play() as played:
            played.script(played.vectors([[0.1] * width]))
            assert await played.provider(model).dimensions() == width
            assert played.inputs == [[PROBE]]

    run(scenario())


@each_provider
def test_it_is_measured_once_and_callers_that_ask_at_once_share_the_measuring(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(HOLD)
            provider = played.provider(MODEL)
            first, second = asyncio.ensure_future(provider.dimensions()), asyncio.ensure_future(provider.dimensions())
            await soon(played.arrived())
            await settle()
            assert (len(played.asked), played.holding) == (1, 1)
            played.release()
            assert list(await soon(asyncio.gather(first, second))) == [WIDTH, WIDTH]
            assert await provider.dimensions() == WIDTH
            assert len(played.asked) == 1

    run(scenario())


@each_provider
def test_a_measuring_that_failed_is_not_kept(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(Answer(status=503, body=b"busy"))
            provider = played.provider(MODEL)
            with pytest.raises(EmbeddingProviderError) as failed:
                await provider.dimensions()
            assert failed.value.status == 503
            # The provider recovers, and the next call measures again.
            assert await provider.dimensions() == WIDTH
            assert played.inputs == [[PROBE], [PROBE]]

    run(scenario())


@each_provider
@pytest.mark.parametrize("answered", [[], [[]]], ids=["no vector", "a vector of no numbers"])
def test_an_answer_that_holds_no_vector_is_a_failure_that_has_the_model_and_is_no_width(play: Play, answered: list[list[float]]) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(played.vectors(answered))
            with pytest.raises(EmbeddingProviderError) as unmeasured:
                await played.provider("some-brand-new-model").dimensions()
            assert (unmeasured.value.status, unmeasured.value.model) == (200, "some-brand-new-model")

    run(scenario())


@each_provider
def test_a_caller_cancelled_while_the_width_is_measured_leaves_at_once_and_the_others_still_get_it(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(HOLD)
            provider = played.provider(MODEL)
            leaving, staying = asyncio.ensure_future(provider.dimensions()), asyncio.ensure_future(provider.dimensions())
            await soon(played.arrived())
            leaving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await leaving
            assert leaving.cancelled()
            # What is measured once for every caller is not one caller's to end: the request is still open.
            await settle()
            assert played.abandoned == []
            assert played.holding == 1
            played.release()
            assert await soon(staying) == WIDTH
            assert len(played.asked) == 1

    run(scenario())


@each_provider
def test_the_measuring_waits_its_turn_as_any_request_does(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            at_once = played.policy.concurrency
            played.rule = always(HOLD)
            provider = played.provider(MODEL)
            embeddings = asyncio.gather(*(provider.embed_query(f"text {number}") for number in range(at_once)))
            await soon(played.arrived(at_once))
            measuring = asyncio.ensure_future(provider.dimensions())
            await settle()
            # Every turn is taken, and the measuring has asked nothing yet.
            assert len(played.asked) == at_once
            played.release()
            await soon(played.arrived(at_once + 1))
            assert played.inputs[-1] == [PROBE]
            played.release()
            assert await soon(measuring) == WIDTH
            assert len(await soon(embeddings)) == at_once

    run(scenario())


# ── a provider that may not be ready yet ────────────────────────────────


@each_provider
def test_a_provider_that_is_ready_is_asked_once(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            assert await resolve_dimensions(played.provider(MODEL).dimensions) == WIDTH
            assert played.inputs == [[PROBE]]

    run(scenario())


@each_provider
def test_a_provider_that_answers_404_is_asked_again_until_its_model_is_there(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(ABSENT, ABSENT, played.vectors([[0.1] * 768]))
            assert await hurried(resolve_dimensions(played.provider(MODEL).dimensions)) == 768
            assert played.inputs == [[PROBE]] * 3

    run(scenario())


@each_provider
def test_the_attempts_are_spent_on_a_model_that_never_comes_and_the_failure_says_both_things_a_404_can_mean(play: Play) -> None:
    # A model whose name is wrong fails after every attempt and not at once: one 404 does not tell it from a model
    # on its way. So what is said at the end must not send its reader to wait for a model that will never come.
    async def scenario() -> None:
        async with play() as played:
            played.rule = always(ABSENT)
            with pytest.raises(RuntimeError) as spent:
                await hurried(resolve_dimensions(played.provider("some-brand-new-model").dimensions))
            said = str(spent.value)
            assert "'some-brand-new-model'" in said
            assert played.name in said
            assert "not been fetched" in said
            assert "model name is wrong" in said
            assert EMBEDDING_PROVIDER_RETRY.attempts == 12
            assert len(played.asked) == 12
            # The provider's own failure is its cause, and has the model as a field.
            cause = spent.value.__cause__
            assert isinstance(cause, EmbeddingProviderError)
            assert (cause.status, cause.model) == (404, "some-brand-new-model")

    run(scenario())


@each_provider
@pytest.mark.parametrize("status", [400, 401, 403, 429, 500, 503])
def test_any_other_refusal_is_raised_at_once_as_it_is(play: Play, status: int) -> None:
    # A retry that never gives up is worse than none: a key that was refused is not accepted for waiting.
    async def scenario() -> None:
        async with play() as played:
            played.script(Answer(status=status, body=b"refused"))
            with pytest.raises(EmbeddingProviderError) as refused:
                await soon(resolve_dimensions(played.provider(MODEL).dimensions))
            assert refused.value.status == status
            assert len(played.asked) == 1

    run(scenario())


def test_a_failure_that_is_no_providers_is_raised_at_once_whatever_status_it_says_it_has() -> None:
    # A 404 from anything else says a thing is not there, and waiting does not change that.
    class Gone(Exception):
        status = 404

    async def scenario() -> None:
        attempts: list[None] = []

        async def dimensions() -> int:
            attempts.append(None)
            raise Gone

        with pytest.raises(Gone):
            await soon(resolve_dimensions(dimensions))
        assert len(attempts) == 1

    run(scenario())


@each_provider
def test_a_request_that_reached_the_provider_and_was_not_answered_is_not_asked_again(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(HANG_UP)
            with pytest.raises(EmbeddingProviderError) as broken:
                await soon(resolve_dimensions(played.provider(MODEL).dimensions))
            assert (broken.value.status, broken.value.reached) == (None, True)
            assert len(played.asked) == 1

    run(scenario())


@each_provider
def test_a_request_that_ran_out_of_its_time_is_not_asked_again(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.rule = always(HOLD)
            resolving = asyncio.ensure_future(resolve_dimensions(played.provider(MODEL).dimensions))
            await soon(played.arrived())
            await pass_time(EMBED_ROUND_TRIP_SECONDS + 1, step=0.5)
            with pytest.raises(EmbeddingProviderError) as late:
                await soon(resolving)
            assert (late.value.status, late.value.reached) == (None, True)
            await settle()
            assert len(played.asked) == 1

    run(scenario())


@each_provider
def test_a_provider_that_is_not_listening_yet_is_asked_again_and_answers_once_it_listens(play: Play) -> None:
    async def scenario() -> None:
        played = unstarted(play)
        provider = played.provider(MODEL)
        attempts: list[None] = []

        async def dimensions() -> int:
            attempts.append(None)
            return await provider.dimensions()

        resolving = asyncio.ensure_future(resolve_dimensions(dimensions))
        # The first two waits are of at most one second and of two: well within five, three attempts were refused.
        await pass_time(5, step=0.25)
        assert len(attempts) >= 3
        assert not resolving.done()
        async with played:
            assert await hurried(resolving) == WIDTH
            assert played.inputs == [[PROBE]]

    run(scenario())


@each_provider
def test_the_attempts_are_spent_on_a_provider_that_never_listens_and_the_failure_says_it_was_not_reached(play: Play) -> None:
    async def scenario() -> None:
        played = unstarted(play)
        provider = played.provider(MODEL)
        attempts: list[None] = []

        async def dimensions() -> int:
            attempts.append(None)
            return await provider.dimensions()

        with pytest.raises(EmbeddingProviderError) as spent:
            await hurried(resolve_dimensions(dimensions))
        # The provider's failure as it is: what could not be reached needs no more said of it.
        assert (spent.value.provider, spent.value.status, spent.value.reached) == (played.name, None, False)
        assert isinstance(spent.value.__cause__, httpx.ConnectError)
        assert len(attempts) == EMBEDDING_PROVIDER_RETRY.attempts

    run(scenario())


def test_the_waits_between_the_attempts_are_the_policys() -> None:
    async def scenario() -> None:
        async with Ollama() as ollama:
            ollama.rule = always(ABSENT)
            provider = ollama.provider(MODEL)
            loop = asyncio.get_running_loop()
            began: list[float] = []
            ended: list[float] = []

            async def dimensions() -> int:
                began.append(loop.time())
                try:
                    return await provider.dimensions()
                finally:
                    ended.append(loop.time())

            with pytest.raises(RuntimeError, match="still unavailable"):
                await hurried(resolve_dimensions(dimensions))
            waits = [again - before for before, again in zip(ended, began[1:], strict=False)]
            # At most 1, 2, 4 and 8 seconds, and then 15: eleven waits between twelve attempts.
            most = [min(2.0**number, 15.0) for number in range(11)]
            assert len(waits) == len(most)
            # Each wait is at least half of its most. The clock is moved a quarter of a second at a time here, so a
            # wait is seen to end up to that much late.
            for wait, cap in zip(waits, most, strict=True):
                assert cap / 2 - 0.01 <= wait <= cap + 0.5

    run(scenario())


# ── stopping ────────────────────────────────────────────────────────────


@each_provider
def test_a_caller_with_a_deadline_stops_it_at_once_and_is_handed_no_failure_of_the_providers(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.rule = always(ABSENT)
            provider = played.provider(MODEL)

            async def connecting() -> int:
                async with asyncio.timeout(20):
                    return await resolve_dimensions(provider.dimensions)

            with pytest.raises(TimeoutError):
                await hurried(connecting())
            await settle()
            asked = len(played.asked)
            assert 1 < asked < EMBEDDING_PROVIDER_RETRY.attempts
            # Nothing is asked for a caller that left, however long the provider goes on.
            await pass_time(60, step=1.0)
            assert len(played.asked) == asked

    run(scenario())


@each_provider
def test_cancelled_in_an_attempt_it_ends_cancelled_and_the_measuring_goes_on_for_the_next_caller(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(HOLD)
            provider = played.provider(MODEL)
            resolving = asyncio.ensure_future(resolve_dimensions(provider.dimensions))
            await soon(played.arrived())
            resolving.cancel()
            with pytest.raises(asyncio.CancelledError):
                await resolving
            assert resolving.cancelled()
            # The measuring is every caller's, and the one that left does not end it: the next caller is answered by it.
            await settle()
            assert played.abandoned == []
            assert played.holding == 1
            played.release()
            assert await soon(provider.dimensions()) == WIDTH
            assert len(played.asked) == 1

    run(scenario())
