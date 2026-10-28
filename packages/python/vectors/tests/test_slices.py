"""Asking a provider for many texts: a batch cut into requests, how many are made at once, how long each may take, what a failure says.

Each of the two providers is held to every case here, against a stand-in
that plays it over HTTP: what one driver did and the other did not would be
a difference nobody chose. What is one provider's own (its call, and how its
answer is read) is in that provider's tests.
"""

import asyncio
import itertools
from collections.abc import Sequence

import httpx
import pytest
from aio import hurried, pass_time, run, settle, soon
from provider import HANG_UP, HOLD, Answer, Ollama, Play, Voyage, always, told, unstarted, wait_out

from semiont_vectors._slices import Batches
from semiont_vectors.embedding import EMBED_ROUND_TRIP_SECONDS, BatchPolicy, EmbeddingProviderError, SliceRef, TextKind

MODEL = "a-model"
PROXIES = ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy")

each_provider = pytest.mark.parametrize("play", [Ollama, Voyage], ids=["ollama", "voyage"])


def numbered(count: int) -> list[str]:
    """`count` texts, each of which says which it is."""
    return [f"t{number}" for number in range(count)]


def first(texts: list[str]) -> int:
    """Which of `numbered`'s texts a request begins with."""
    return int(texts[0].removeprefix("t"))


def growing(count: int) -> list[str]:
    """`count` texts, each a character longer than the one before, so that the vector a stand-in answers says which text it is of."""
    return ["x" * (number + 1) for number in range(count)]


# ── cutting, and the order ──────────────────────────────────────────────


@each_provider
def test_a_batch_is_cut_into_requests_of_at_most_a_slice_each_of_texts_that_follow_one_another(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            size = played.policy.slice_size
            # Not a whole number of slices: the last request carries the one text left over.
            texts = numbered(size * 2 + 1)
            assert len(await played.provider(MODEL).embed_documents(texts)) == len(texts)
            # Requests made at once may arrive in any order. They are put in the order of their texts here.
            assert sorted(played.inputs, key=first) == [texts[:size], texts[size : size * 2], texts[size * 2 :]]

    run(scenario())


@each_provider
def test_the_vectors_are_in_the_order_of_the_texts(play: Play) -> None:
    # Whoever asked matches each vector to its text by its place: an order changed would be wrong and say nothing.
    async def scenario() -> None:
        async with play() as played:
            texts = growing(played.policy.slice_size * 2 + 3)
            assert await played.provider(MODEL).embed_documents(texts) == [told(text) for text in texts]

    run(scenario())


def test_the_vectors_are_in_the_order_of_the_texts_whatever_order_the_requests_are_answered_in() -> None:
    # Only a provider that is asked several requests at once can answer them out of order.
    async def scenario() -> None:
        async with Voyage() as voyage:
            size, at_once = voyage.policy.slice_size, voyage.policy.concurrency
            texts = growing(size * at_once)

            def which(asked: list[str]) -> int:
                """Which request of the batch carries these texts, counted from 0."""
                return (len(asked[0]) - 1) // size

            def the_first_answered_last(asked: list[str]) -> Answer:
                return voyage.echo(asked, after=float(at_once - which(asked)))

            voyage.rule = the_first_answered_last
            embedding = asyncio.ensure_future(voyage.provider(MODEL).embed_documents(texts))
            await soon(voyage.arrived(at_once))
            await pass_time(at_once + 1, step=0.1)
            assert await soon(embedding) == [told(text) for text in texts]
            assert [which(answered.texts) for answered in voyage.answered] == list(reversed(range(at_once)))

    run(scenario())


@each_provider
def test_no_texts_are_no_requests(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            assert await played.provider(MODEL).embed_documents([]) == []
            assert played.asked == []

    run(scenario())


@each_provider
def test_one_text_is_asked_as_a_batch_of_one(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            assert await played.provider(MODEL).embed_query("solo") == told("solo")
            assert played.inputs == [["solo"]]

    run(scenario())


def test_every_request_of_a_batch_is_told_what_the_texts_of_the_batch_are_for() -> None:
    # Asked through no provider: what a request is told is what a driver is handed, whatever it then sends of it.
    async def scenario() -> None:
        handed: list[tuple[str, TextKind]] = []

        async def post(texts: Sequence[str], kind: TextKind) -> list[list[float]]:
            handed.append((texts[0], kind))
            return [told(text) for text in texts]

        batches = Batches(provider="voyage", model=MODEL, policy=BatchPolicy(slice_size=1, concurrency=1), post=post)
        await batches.embed(["a", "b"], "document")
        await batches.embed(["c"], "query")
        assert handed == [("a", "document"), ("b", "document"), ("c", "query")]

    run(scenario())


# ── how many at once ────────────────────────────────────────────────────


@each_provider
def test_no_more_requests_are_made_at_once_than_the_policy_says_however_many_callers_ask(play: Play) -> None:
    # The bound is the provider's and not a call's: three callers of one provider share it. A bound kept by each
    # call would let through three times as many.
    async def scenario() -> None:
        async with play() as played:
            size, at_once = played.policy.slice_size, played.policy.concurrency
            played.rule = always(HOLD)
            provider = played.provider(MODEL)
            callers, wanted = 3, 6
            batches = asyncio.gather(*(provider.embed_documents(numbered(size * 2)) for _ in range(callers)))
            seen = 0
            while seen < wanted:
                wave = min(at_once, wanted - seen)
                await soon(played.arrived(seen + wave))
                # Long enough for a request made beyond the bound to arrive.
                await settle()
                assert (len(played.asked), played.holding) == (seen + wave, wave)
                seen += wave
                played.release()
            assert [len(vectors) for vectors in await soon(batches)] == [size * 2] * callers
            assert played.most_at_once == at_once

    run(scenario())


@each_provider
def test_single_texts_wait_their_turn_as_the_requests_of_a_batch_do(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            at_once = played.policy.concurrency
            played.rule = always(HOLD)
            provider = played.provider(MODEL)
            singles = asyncio.gather(*(provider.embed_query(text) for text in growing(at_once + 1)))
            await soon(played.arrived(at_once))
            await settle()
            assert (len(played.asked), played.holding) == (at_once, at_once)
            played.release()
            await soon(played.arrived(at_once + 1))
            played.release()
            assert await soon(singles) == [told(text) for text in growing(at_once + 1)]

    run(scenario())


# ── how long a request may take ─────────────────────────────────────────


@each_provider
def test_a_request_not_answered_in_its_time_fails_as_one_that_was_reached_and_is_let_go_of(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(HOLD)
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(["a"]))
            await soon(played.arrived())
            await pass_time(EMBED_ROUND_TRIP_SECONDS - 3, step=0.5)
            assert not embedding.done()
            await pass_time(4, step=0.5)
            with pytest.raises(EmbeddingProviderError) as late:
                await soon(embedding)
            failure = late.value
            assert (failure.provider, failure.status, failure.reached, failure.model) == (played.name, None, True, MODEL)
            assert failure.slice == SliceRef(index=0, start=0, end=1)
            assert isinstance(failure.__cause__, TimeoutError)
            # The request is not left open at the provider.
            await soon(played.given_up())

    run(scenario())


@each_provider
def test_a_requests_time_is_for_the_whole_of_it_and_does_not_begin_again_with_each_byte(play: Play) -> None:
    # The head of the answer comes at once, and then a byte of its body every five seconds. No wait for a byte is
    # long, and the answer is far from whole when the request's time is up.
    async def scenario() -> None:
        async with play() as played:

            def a_byte_at_a_time(asked: list[str]) -> Answer:
                return played.echo(asked, drip=5.0)

            played.rule = a_byte_at_a_time
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(["a"]))
            await soon(played.arrived())
            await pass_time(EMBED_ROUND_TRIP_SECONDS - 3, step=0.5)
            assert not embedding.done()
            await pass_time(4, step=0.5)
            with pytest.raises(EmbeddingProviderError) as late:
                await soon(embedding)
            assert (late.value.status, late.value.reached) == (None, True)
            assert isinstance(late.value.__cause__, TimeoutError)

    run(scenario())


@each_provider
def test_a_request_that_waited_its_turn_has_its_whole_time(play: Play) -> None:
    # Each request is answered after more than half of a request's time, and the last one waits behind the first:
    # it is answered later after its batch began than one request may take, and that is no failure.
    slow = EMBED_ROUND_TRIP_SECONDS * 0.6

    async def scenario() -> None:
        async with play() as played:
            size, at_once = played.policy.slice_size, played.policy.concurrency
            texts = numbered(size * (at_once + 1))

            def slowly(asked: list[str]) -> Answer:
                return played.echo(asked, after=slow)

            played.rule = slowly
            loop = asyncio.get_running_loop()
            began = loop.time()
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(texts))
            await soon(played.arrived(at_once))
            await pass_time(slow * 2 + 1, step=0.1)
            assert len(await soon(embedding)) == len(texts)
            # The last request was made when a turn came free, and its answer came after a request's time had passed.
            assert played.asked[-1].at - began >= slow
            assert loop.time() - began > EMBED_ROUND_TRIP_SECONDS

    run(scenario())


# ── failures ────────────────────────────────────────────────────────────


@each_provider
def test_a_request_that_fails_fails_its_batch_and_says_which_request_it_was(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            size = played.policy.slice_size

            def the_second_refused(asked: list[str]) -> Answer | None:
                return Answer(status=500, body=b"boom") if first(asked) == size else None

            played.rule = the_second_refused
            with pytest.raises(EmbeddingProviderError) as failed:
                await played.provider(MODEL).embed_documents(numbered(size * 2))
            failure = failed.value
            assert (failure.provider, failure.model) == (played.name, MODEL)
            assert (failure.status, failure.reached, failure.body) == (500, True, "boom")
            assert failure.slice == SliceRef(index=1, start=size, end=size * 2)
            # The status is in the message too, so that a line of a log reads by itself.
            assert "500" in str(failure)

    run(scenario())


@each_provider
def test_a_request_that_fails_ends_the_others_and_those_that_waited_are_never_made(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            size, at_once = played.policy.slice_size, played.policy.concurrency
            # The last of the requests made at once is the one refused.
            failing = at_once - 1

            def one_refused(asked: list[str]) -> Answer:
                return Answer(status=500, body=b"boom", after=5.0) if first(asked) == size * failing else HOLD

            played.rule = one_refused
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(numbered(size * (at_once + 2))))
            # Every request the policy allows at once is at the provider before one of them is refused.
            await soon(played.arrived(at_once))
            await settle()
            await pass_time(6, step=1.0)
            with pytest.raises(EmbeddingProviderError) as failed:
                await soon(embedding)
            assert failed.value.status == 500
            assert failed.value.slice == SliceRef(index=failing, start=size * failing, end=size * (failing + 1))
            # The requests still unanswered are let go of, and the two that waited for a turn are never made.
            # That no task is left behind is `run`'s to hold.
            await soon(played.given_up(at_once - 1))
            await settle()
            assert (len(played.asked), played.holding) == (at_once, 0)

    run(scenario())


def test_where_two_requests_failed_the_failure_raised_is_that_of_the_earlier_texts() -> None:
    # Asked through no provider: only a request the test itself makes can be made to fail at a chosen moment.
    async def scenario() -> None:
        failing = [asyncio.Event(), asyncio.Event()]

        async def post(texts: Sequence[str], kind: TextKind) -> list[list[float]]:
            await failing[int(texts[0])].wait()
            raise EmbeddingProviderError(provider="voyage", status=500, reached=True, model=MODEL, body=f"refused {texts[0]}")

        batches = Batches(provider="voyage", model=MODEL, policy=BatchPolicy(slice_size=1, concurrency=2), post=post)
        embedding = asyncio.ensure_future(batches.embed(["0", "1"], "document"))
        await settle()
        # The later request fails first, and the earlier one in the same turn of the loop, before it can be cancelled.
        failing[1].set()
        failing[0].set()
        with pytest.raises(EmbeddingProviderError) as failed:
            await soon(embedding)
        assert (failed.value.body, failed.value.slice) == ("refused 0", SliceRef(index=0, start=0, end=1))

    run(scenario())


@each_provider
def test_a_caller_that_is_cancelled_ends_its_requests_and_is_handed_its_cancellation_and_no_failure(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            size, at_once = played.policy.slice_size, played.policy.concurrency
            played.rule = always(HOLD)
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(numbered(size * (at_once + 2))))
            await soon(played.arrived(at_once))
            await settle()
            embedding.cancel()
            with pytest.raises(asyncio.CancelledError):
                await embedding
            assert embedding.cancelled()
            # Nothing goes on being embedded for a caller that left, and nothing more is asked for it.
            await soon(played.given_up(at_once))
            await settle()
            assert len(played.asked) == at_once

    run(scenario())


@each_provider
def test_a_provider_that_is_not_listening_was_not_reached(play: Play) -> None:
    async def scenario() -> None:
        played = unstarted(play)
        with pytest.raises(EmbeddingProviderError) as unreached:
            await played.provider(MODEL).embed_query("a")
        failure = unreached.value
        assert (failure.provider, failure.status, failure.reached, failure.model) == (played.name, None, False, MODEL)
        assert failure.slice == SliceRef(index=0, start=0, end=1)
        # The failure of the connection is its cause, and is said in its words.
        assert isinstance(failure.__cause__, httpx.ConnectError)
        assert failure.body.startswith("ConnectError")
        assert "no response" in str(failure)

    run(scenario())


@each_provider
def test_a_connection_that_ends_unanswered_was_reached(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(HANG_UP)
            with pytest.raises(EmbeddingProviderError) as broken:
                await played.provider(MODEL).embed_query("a")
            assert (broken.value.status, broken.value.reached) == (None, True)
            assert isinstance(broken.value.__cause__, httpx.TransportError)
            # Asked once: a provider is asked again where it said it is busy, and this one said nothing.
            assert len(played.asked) == 1

    run(scenario())


# ── a provider that says it is busy ─────────────────────────────────────


@each_provider
@pytest.mark.parametrize("status", [429, 503])
def test_a_provider_that_says_it_is_busy_is_asked_again_a_second_later_and_then_answers(play: Play, status: int) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.script(Answer(status=status, body=b"busy"))
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(["a", "bc"]))
            await wait_out(played, [1.0])
            assert await soon(embedding) == [told("a"), told("bc")]
            assert played.inputs == [["a", "bc"], ["a", "bc"]]
            busy, answered = played.asked
            # A second of the loop's clock, and the moment of real time the first answer was given to be read in.
            assert 1.0 <= answered.at - busy.at < 1.5

    run(scenario())


@each_provider
@pytest.mark.parametrize("status", [429, 503])
def test_a_provider_that_stays_busy_is_asked_four_times_and_the_failure_is_its_last_answer(play: Play, status: int) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.rule = always(Answer(status=status, body=b"busy"))
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(["a"]))
            await wait_out(played, [1.0, 2.0, 4.0])
            with pytest.raises(EmbeddingProviderError) as busy:
                await soon(embedding)
            failure = busy.value
            assert (failure.provider, failure.status, failure.reached, failure.body) == (played.name, status, True, "busy")
            assert failure.slice == SliceRef(index=0, start=0, end=1)
            # Asked four times, after waits of one, two and four seconds: seven of a request's fifteen.
            waits = [later.at - earlier.at for earlier, later in itertools.pairwise(played.asked)]
            assert len(waits) == 3
            for waited, wait in zip(waits, [1.0, 2.0, 4.0], strict=True):
                assert wait <= waited < wait + 0.5

    run(scenario())


@each_provider
@pytest.mark.parametrize("status", [400, 404, 500, 502, 504])
def test_a_refusal_that_does_not_say_the_provider_is_busy_fails_the_request_at_once(play: Play, status: int) -> None:
    async def scenario() -> None:
        async with play() as played:
            played.rule = always(Answer(status=status, body=b"refused"))
            with pytest.raises(EmbeddingProviderError) as refused:
                await soon(played.provider(MODEL).embed_documents(["a"]))
            assert refused.value.status == status
            assert len(played.asked) == 1

    run(scenario())


@each_provider
def test_a_busy_answer_that_leaves_no_time_for_the_wait_is_the_failure_and_nothing_more_is_asked(play: Play) -> None:
    # The answer comes when a second of the request's time is left, and the wait before asking again is a second:
    # it would end at the deadline, so it is not begun.
    late = EMBED_ROUND_TRIP_SECONDS - 1.0

    async def scenario() -> None:
        async with play() as played:
            played.script(Answer(status=429, body=b"busy", after=late))
            embedding = asyncio.ensure_future(played.provider(MODEL).embed_documents(["a"]))
            await soon(played.arrived())
            await pass_time(late, step=0.5)
            with pytest.raises(EmbeddingProviderError) as busy:
                await soon(embedding)
            assert (busy.value.status, busy.value.reached, busy.value.body) == (429, True, "busy")
            assert busy.value.slice == SliceRef(index=0, start=0, end=1)
            assert len(played.asked) == 1

    run(scenario())


@each_provider
@pytest.mark.parametrize("status", [429, 503])
def test_a_query_of_a_busy_provider_fails_at_once_and_is_not_asked_again(play: Play, status: int) -> None:
    # Whoever searches is waiting, and is answered without the provider sooner than it is kept waiting on it.
    async def scenario() -> None:
        async with play() as played:
            played.rule = always(Answer(status=status, body=b"busy"))
            with pytest.raises(EmbeddingProviderError) as busy:
                await soon(played.provider(MODEL).embed_query("a"))
            assert (busy.value.status, busy.value.reached, busy.value.body) == (status, True, "busy")
            assert len(played.asked) == 1

    run(scenario())


def test_a_request_keeps_its_turn_while_it_waits_to_ask_a_busy_provider_again() -> None:
    # Asked through no provider, of a policy of one request at a time: a turn given up for the wait would let the
    # second request in before the first is over.
    async def scenario() -> None:
        asked: list[str] = []

        async def post(texts: Sequence[str], kind: TextKind) -> list[list[float]]:
            asked.append(texts[0])
            if len(asked) == 1:
                raise EmbeddingProviderError(provider="ollama", status=429, reached=True, model=MODEL, body="busy")
            return [told(text) for text in texts]

        batches = Batches(provider="ollama", model=MODEL, policy=BatchPolicy(slice_size=1, concurrency=1), post=post)
        assert await hurried(batches.embed(["first", "second"], "document")) == [told("first"), told("second")]
        assert asked == ["first", "first", "second"]

    run(scenario())


# ── where a request goes ────────────────────────────────────────────────


@each_provider
def test_the_address_it_was_given_is_the_address_asked_whatever_proxy_and_certificates_the_environment_names(
    play: Play, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        async with play() as played, play() as proxy:
            for name in PROXIES:
                monkeypatch.setenv(name, proxy.origin)
            for name in ("NO_PROXY", "no_proxy"):
                monkeypatch.delenv(name, raising=False)
            monkeypatch.setenv("SSL_CERT_FILE", "/nowhere/certificates.pem")
            assert await played.provider(MODEL).embed_query("solo") == told("solo")
            assert proxy.asked == []
            assert played.inputs == [["solo"]]

    run(scenario())


@each_provider
def test_a_redirect_is_not_followed_so_texts_go_nowhere_the_caller_did_not_name(play: Play) -> None:
    async def scenario() -> None:
        async with play() as played, play() as elsewhere:
            played.script(Answer(status=307, headers={"location": f"{elsewhere.origin}{elsewhere.path}"}))
            with pytest.raises(EmbeddingProviderError) as redirected:
                await played.provider(MODEL).embed_query("a")
            assert redirected.value.status == 307
            assert elsewhere.asked == []

    run(scenario())
