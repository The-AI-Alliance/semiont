@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package semiont.session

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import semiont.Timings
import semiont.errors.BusRequestError
import semiont.errors.BusRequestErrorCode
import semiont.errors.SemiontError
import semiont.errors.SessionError
import semiont.errors.SessionErrorCode
import semiont.errors.SignInError
import semiont.errors.SignInErrorCode
import semiont.errors.TransportError
import semiont.signin.HeldSignIn
import semiont.signin.MemorySignIn
import semiont.signin.SCRIPT_CLIENT_ID
import semiont.testing.TestClient
import semiont.types.UserResponse
import java.io.IOException
import kotlin.random.Random

/** A gateway that holds its answer about one token until it is released, and then refuses it; of any other token it says `ofOthers`. */
private class Slowly(private val heldToken: String, private val ofOthers: Any) {
    val asked = mutableListOf<String>()
    val release = CompletableDeferred<Unit>()

    suspend fun validate(asked: String): UserResponse {
        this.asked += asked
        if (asked == heldToken) {
            release.await()
            throw unauthorized()
        }
        return when (ofOthers) {
            is SemiontError -> throw ofOthers
            else -> ofOthers as UserResponse
        }
    }
}

/**
 * What a session does beyond the table's rows (session/cases.json): at its
 * start, when the gateway refuses its token, as it is renewed, and as it ends.
 */
class SessionTest {
    // At its start.

    @Test
    fun aKeptTokenThatIsStillGoodIsTheSessionsAtOnceAndSaysWhoItIs() = runTest {
        val access = token(3600, 1)
        val world = SessionWorld(kept = access)
        world.session().use { session ->
            session.start()
            // Before anything has run: it is what the transport sends first.
            assertEquals(access, session.token.value)
            session.ready()
            assertEquals(listOf(access), world.validated)
            assertEquals(alice, session.user.value)
            assertEquals(0, world.renewed)
            assertTrue(checkNotNull(session.expiresAt()) > System.currentTimeMillis() / 1000.0 + 3500)
        }
    }

    @Test
    fun aKeptTokenThatNamesNoExpiryIsRenewedBeforeAnyoneIsAsked() = runTest {
        // Nothing says it is still good.
        val renewed = token(3600, 2)
        val world = SessionWorld(kept = jwt(buildJsonObject { put("sub", "alice") }), renewals = listOf(renewed))
        world.session().use { session ->
            session.start()
            assertNull(session.token.value)
            session.ready()
            assertEquals(listOf(renewed), world.validated)
            assertEquals(renewed, session.token.value)
        }
    }

    @Test
    fun aGatewayThatFailsInSomeOtherWayHasRefusedNothingEither() = runTest {
        val access = token(3600, 1)
        val renewed = token(3600, 2)
        val unanswered = BusRequestError(BusRequestErrorCode.Timeout, "nobody answered")

        val atItsStart = SessionWorld(kept = access, validations = listOf(unanswered))
        atItsStart.session().use { session ->
            session.start()
            session.ready()
            assertEquals(access to null, session.token.value to session.user.value)
            assertEquals(listOf("session.auth-failed" to "nobody answered"), atItsStart.said())
            assertEquals(Triple(emptyList<SessionEndReason>(), 0, true), Triple(atItsStart.told, atItsStart.renewed, atItsStart.isKept()))
        }

        val whenRefused = SessionWorld(kept = access, renewals = listOf(renewed), validations = listOf(alice, unanswered))
        whenRefused.session().use { session ->
            session.start()
            session.ready()
            assertEquals(renewed, session.refresh(session.token.value))
            assertEquals(Triple(emptyList<SessionEndReason>(), emptyList<Any>(), true), Triple(whenRefused.told, whenRefused.errors, whenRefused.isKept()))
        }
    }

    @Test
    fun aTokenTheSessionWasGivenIsNotReplacedByTheKeptOne() = runTest {
        val world = SessionWorld(kept = token(3600, 1))
        val given = token(3600, 2)
        world.token.value = given
        world.session().use { session ->
            session.start()
            session.ready()
            assertEquals(given, session.token.value)
        }
    }

    @Test
    fun aSessionOfAServiceAsksNobodyWhoItIs() = runTest {
        val access = token(3600, 1)
        val world = SessionWorld(kept = access)
        world.session(asking = null).use { session ->
            session.start()
            session.ready()
            assertEquals(access, session.token.value)
            assertNull(session.user.value)
            assertEquals(emptyList<String>(), world.validated)
        }
    }

    @Test
    fun anExpiredTokenTheIssuerWillNotRenewIsForgottenAndTheSessionIsReadyAnyway() = runTest {
        val refusedWithNoToken = SignInError(SignInErrorCode.Exchange, "The issuer refused the token request (HTTP 200)", 200)
        for (renewal in listOf(null, refusedByTheIssuer(), refusedWithNoToken)) {
            val world = SessionWorld(kept = expired(), renewals = listOf(renewal))
            world.session().use { session ->
                session.start()
                session.ready()
                assertNull(session.token.value)
                assertNull(session.user.value)
                assertFalse(world.isKept())
                // There was no session to end: nothing is said.
                assertEquals(emptyList<SessionEndReason>() to emptyList<Any>(), world.told to world.errors)
            }
        }
    }

    @Test
    fun anExpiredTokenTheIssuerRefusedWhoseSignInCannotBeForgottenIsSaidWithWhyItHadToBe() = runTest {
        val world = SessionWorld(kept = expired(), renewals = listOf(refusedByTheIssuer()))
        world.unforgettable = true
        world.session().use { session ->
            session.start()
            session.ready()
            assertNull(session.token.value)
            assertTrue(world.isKept())
            // There was no session to end, so nobody is told one ended: what is said is why the sign-in is kept still.
            assertEquals(emptyList<SessionEndReason>(), world.told)
            assertEquals(
                listOf("session.refresh-exhausted" to "Token refresh failed: ${refusedByTheIssuer().message}; and the sign-in could not be forgotten: ${IOException(UNFORGETTABLE)}"),
                world.said(),
            )
        }
    }

    @Test
    fun anExpiredTokenWhoseRenewalGotNoAnswerIsKeptAndRenewedWhenARequestIsRefused() = runTest {
        val renewed = token(3600, 2)
        val spentOnNotNow = SignInError(SignInErrorCode.Exchange, "The session could not be renewed after 4 attempts: HTTP 503", 503)
        for (failure in listOf(unansweredByTheIssuer(), spentOnNotNow)) {
            val world = SessionWorld(kept = expired(), renewals = listOf(failure, renewed))
            world.session().use { session ->
                session.start()
                session.ready()
                assertNull(session.token.value)
                assertTrue(world.isKept())
                assertEquals(emptyList<SessionEndReason>(), world.told)
                assertEquals(listOf("session.auth-failed" to "Token refresh failed: ${failure.message}"), world.said())
                // The issuer answers again: a request refused for want of a token renews it.
                assertEquals(renewed, session.refresh(session.token.value))
                assertEquals(renewed, session.token.value)
                assertEquals(2, world.renewed)
            }
        }
    }

    // The session's stream opens with the kept token as the session starts asking who that token is, so the stream's
    // refusal can land first. While the session is starting, a refusal only renews: the start finds the renewed token
    // and asks about it. One renewal, one ask about it, one ending.
    @Test
    fun aStreamRefusedWhileTheSessionIsStartingCostsOneRenewalAndOneEnding() = runTest {
        val access = token(3600, 1)
        val renewed = token(3600, 2)
        val world = SessionWorld(kept = access, renewals = listOf(renewed, token(3600, 3)))
        val gateway = Slowly(access, unauthorized())
        world.session(asking = { gateway.validate(it) }).use { session ->
            session.start()
            runCurrent()
            // The stream's refusal arrives before the start has its answer.
            val refreshing = async { session.refresh(session.token.value) }
            runCurrent()
            gateway.release.complete(Unit)
            session.ready()

            assertEquals(renewed, refreshing.await())
            assertEquals(listOf(access, renewed), gateway.asked)
            assertEquals(1, world.renewed)
            assertEquals(listOf(SessionEndReason.REFUSED), world.told)
            assertEquals(listOf("session.credential-refused"), world.errors.map { it.code })
            assertNull(session.token.value)
        }
    }

    @Test
    fun aTokenRenewedWhileTheSessionIsStartingIsTakenUpAndNotRenewedAgain() = runTest {
        val access = token(3600, 1)
        val renewed = token(3600, 2)
        val world = SessionWorld(kept = access, renewals = listOf(renewed, token(3600, 3)))
        val gateway = Slowly(access, alice)
        world.session(asking = { gateway.validate(it) }).use { session ->
            session.start()
            runCurrent()
            val refreshing = async { session.refresh(session.token.value) }
            runCurrent()
            gateway.release.complete(Unit)
            session.ready()

            assertEquals(renewed, refreshing.await())
            assertEquals(listOf(access, renewed), gateway.asked)
            assertEquals(1, world.renewed)
            assertEquals(renewed, session.token.value)
            assertEquals(alice, session.user.value)
            assertEquals(emptyList<SessionEndReason>() to emptyList<Any>(), world.told to world.errors)
        }
    }

    // When the gateway refuses its token.

    @Test
    fun refusalsThatArriveTogetherCostOneRenewalAndOneAsk() = runTest {
        val access = token(3600, 1)
        val renewed = token(3600, 2)
        val world = SessionWorld(kept = access)
        var renewals = 0
        // An issuer that takes a moment, as one does: the refusals overlap.
        val takesAMoment: suspend (String?) -> String? = {
            renewals += 1
            delay(10)
            renewed
        }
        world.session(renew = takesAMoment).use { session ->
            session.start()
            session.ready()
            // Three requests refused at once: each asks the session to refresh.
            val given = List(3) { async { session.refresh(session.token.value) } }.awaitAll()
            assertEquals(listOf(renewed, renewed, renewed), given)
            assertEquals(1, renewals)
            assertEquals(listOf(access, renewed), world.validated)
            // A refusal after that is a new one.
            session.refresh(session.token.value)
            assertEquals(2, renewals)
        }
    }

    @Test
    fun aSessionIsNotEndedByTheRefusalOfATokenItNoLongerHolds() = runTest {
        val access = token(3600, 1)
        val renewed = token(3600, 2)
        val other = token(3600, 9)
        val world = SessionWorld(kept = access, renewals = listOf(renewed))
        // The gateway holds its answer about the renewed token until released.
        val gateway = Slowly(renewed, alice)
        world.session(asking = { gateway.validate(it) }).use { session ->
            session.start()
            session.ready()
            val refreshing = async { session.refresh(session.token.value) }
            runCurrent()
            // The token is replaced while the gateway is being asked.
            world.token.value = other
            gateway.release.complete(Unit)

            assertEquals(other, refreshing.await())
            assertEquals(other, session.token.value)
            assertEquals(emptyList<SessionEndReason>(), world.told)
        }
    }

    @Test
    fun refreshGivesTheNewTokenAndMakesItTheSessions() = runTest {
        val renewed = token(3600, 2)
        val world = SessionWorld(kept = token(3600, 1), renewals = listOf(renewed))
        world.session().use { session ->
            session.start()
            session.ready()
            assertEquals(renewed, session.refresh(session.token.value))
            assertEquals(renewed, session.token.value)
            assertEquals(emptyList<SessionEndReason>(), world.told)
        }
    }

    // How it is renewed.

    @Test
    fun anIdleSessionRenewsItsTokenOncePerHalfLifeAndNoOftener() = runTest {
        // A five-minute token, and every renewal gives another: a margin of five minutes would make each one due the
        // moment it was issued.
        val world = SessionWorld(kept = token(300, 0), renewals = (1 until 100).map { token(300, it) })
        world.session().use { session ->
            session.start()
            session.ready()
            // Half its life is 150 seconds, less whatever of a second had passed when it was issued.
            advanceTimeBy(140_000)
            assertEquals(0, world.renewed)
            advanceTimeBy(12_000)
            assertEquals(1, world.renewed)
            // Each token after it is issued as the clock is moved, and the clock a token's claims are read against is
            // not the one moved: so each is due 150 seconds after the one before.
            advanceTimeBy(600_000)
            assertEquals(5, world.renewed)
            // A renewal on the session's own schedule follows no refusal: the gateway was asked who the token is when
            // the session started, and not since.
            assertEquals(1, world.validated.size)
        }
    }

    // A refusal's renewal is still under way when the token's wait runs out: the schedule waits for it, finds the
    // token it was due for replaced, and renews nothing. The renewed token has a wait of its own.
    @Test
    fun aWaitThatRanOutForATokenSinceReplacedRenewsNothing() = runTest {
        val access = token(300, 0)
        val renewed = token(3600, 1)
        val world = SessionWorld(kept = access, renewals = listOf(renewed, token(3600, 2)))
        // An issuer that takes a while to answer: twenty seconds.
        world.session(renew = { holding -> world.refresh(holding).also { delay(20_000) } }).use { session ->
            session.start()
            session.ready()
            // Half the token's life is 150 seconds, less whatever of a second had passed when it was issued.
            advanceTimeBy(140_000)
            val refreshing = async { session.refresh(access) }
            runCurrent()
            advanceTimeBy(60_000)
            assertEquals(renewed, refreshing.await())
            assertEquals(listOf<String?>(access), world.handed)
            assertEquals(renewed, session.token.value)
        }
    }

    @Test
    fun aSessionThatCannotBeRenewedIsOverAndSaysSoOnce() = runTest {
        val world = SessionWorld(kept = token(3600, 1))
        world.session().use { session ->
            session.start()
            session.ready()
            assertNull(session.refresh(session.token.value))
            assertNull(session.token.value)
            // The dead credential is not kept to be used again.
            assertFalse(world.isKept())
            assertEquals(listOf(SessionEndReason.EXPIRED), world.told)
            assertEquals(listOf("session.refresh-exhausted" to "Token refresh failed"), world.said())
            // What follows finds nothing kept, and is quiet.
            assertNull(session.refresh(session.token.value))
            assertEquals(1 to 1, world.told.size to world.errors.size)
        }
    }

    @Test
    fun aRenewalTheIssuerRefusedEndsTheSessionAndNamesItsCause() = runTest {
        val world = SessionWorld(kept = token(3600, 1), renewals = listOf(refusedByTheIssuer()))
        world.session().use { session ->
            session.start()
            session.ready()
            assertNull(session.refresh(session.token.value))
            assertFalse(world.isKept())
            assertEquals(listOf(SessionEndReason.EXPIRED), world.told)
            assertEquals(listOf("session.refresh-exhausted" to "Token refresh failed: ${refusedByTheIssuer().message}"), world.said())
        }
    }

    @Test
    fun aSessionThatEndsAndCannotForgetItsSignInSaysWhyUnderItsEndingsCode() = runTest {
        val world = SessionWorld(kept = token(3600, 1), renewals = listOf(refusedByTheIssuer()))
        world.session().use { session ->
            session.start()
            session.ready()
            world.unforgettable = true
            assertNull(session.refresh(session.token.value))
            assertTrue(world.isKept())
            assertEquals(listOf(SessionEndReason.EXPIRED), world.told)
            assertEquals(
                listOf("session.refresh-exhausted" to "Token refresh failed: ${refusedByTheIssuer().message}; and the sign-in could not be forgotten: ${IOException(UNFORGETTABLE)}"),
                world.said(),
            )
        }
    }

    @Test
    fun aRenewalThatGotNoAnswerKeepsWhatIsKeptAndTheNextRefusalRenewsAgain() = runTest {
        val renewed = token(3600, 2)
        val spentOnNotNow = SignInError(SignInErrorCode.Exchange, "The session could not be renewed after 4 attempts: HTTP 503", 503)
        for (failure in listOf(unansweredByTheIssuer(), spentOnNotNow)) {
            val world = SessionWorld(kept = token(3600, 1), renewals = listOf(failure, renewed))
            world.session().use { session ->
                session.start()
                session.ready()
                assertNull(session.refresh(session.token.value))
                // No usable token, what is kept stays, and the session is not over.
                assertNull(session.token.value)
                assertTrue(world.isKept())
                assertEquals(emptyList<SessionEndReason>(), world.told)
                assertEquals(listOf("session.refresh-exhausted" to "Token refresh failed: ${failure.message}"), world.said())
                assertEquals(renewed, session.refresh(session.token.value))
                assertEquals(renewed, session.token.value)
            }
        }
    }

    @Test
    fun aRenewalThatGotNoAnswerIsTriedAgainOnTheReconnectBackoffUntilOneIsMade() = runTest {
        val waits = (0 until 6).map { minOf(Timings.RECONNECT_MS shl it, Timings.MAX_RECONNECT_MS) }
        val renewed = token(3600, 2)
        val world = SessionWorld(kept = token(3600, 1), renewals = waits.map { unansweredByTheIssuer() } + renewed)
        world.clock = { testScheduler.currentTime }
        world.session().use { session ->
            session.start()
            session.ready()
            assertNull(session.refresh(session.token.value))
            // Past every wait at its longest: the renewal made ends them.
            advanceTimeBy(waits.sum() + 30_000)
            runCurrent()
            assertEquals(waits.size + 1, world.renewed)
            // Each wait is the equal jitter of its step, the step doubling from the reconnect wait up to the longest.
            for ((gap, wait) in world.renewedAt.zipWithNext { earlier, later -> later - earlier }.zip(waits)) {
                assertTrue(gap in wait / 2..wait, "waited $gap of a step of $wait")
            }
            assertEquals(renewed, session.token.value)
            // The renewal made ends the waits, and asks nobody.
            advanceTimeBy(4 * Timings.MAX_RECONNECT_MS)
            runCurrent()
            assertEquals(waits.size + 1 to 1, world.renewed to world.validated.size)
        }
    }

    @Test
    fun aRenewalIsHandedTheTokenTheSessionHolds() = runTest {
        val access = token(3600, 1)
        val renewed = token(300, 2)
        val world = SessionWorld(kept = access, renewals = listOf(renewed, token(300, 3)))
        world.session().use { session ->
            session.start()
            session.ready()
            // The gateway refused the token the session holds: that is the token renewed.
            assertEquals(renewed, session.refresh(session.token.value))
            // Half the renewed token's life later, on the session's own schedule: the token it holds then.
            advanceTimeBy(160_000)
            runCurrent()
            assertEquals(listOf<String?>(access, renewed), world.handed)
        }
    }

    @Test
    fun aSignInThatCannotBeReadAsARenewalGetsNoAnswerIsARenewalWithNoAnswerAndTheBackoffGoesOn() = runTest {
        val renewed = token(3600, 2)
        val world = SessionWorld(kept = token(3600, 1), renewals = listOf(unansweredByTheIssuer(), unansweredByTheIssuer(), renewed))
        world.session().use { session ->
            session.start()
            session.ready()
            world.unreadable = true
            // The renewal got no answer, and whether a sign-in is kept cannot be read: no usable token, and the session is not over.
            assertNull(session.refresh(session.token.value))
            assertNull(session.token.value)
            assertEquals(emptyList<SessionEndReason>(), world.told)
            assertEquals(listOf("session.refresh-exhausted"), world.errors.map { it.code })
            // Past the first two waits of the backoff at their longest: the first renewal on it meets the same, and says
            // so, and the next is made.
            advanceTimeBy(Timings.RECONNECT_MS * 3 + 1_000)
            runCurrent()
            assertEquals(3, world.renewed)
            assertEquals(renewed, session.token.value)
            assertEquals(listOf("session.refresh-exhausted", "session.refresh-exhausted"), world.errors.map { it.code })
            assertEquals(emptyList<SessionEndReason>(), world.told)
            assertTrue(world.isKept())
        }
    }

    @Test
    fun theIssuersRefusalEndsTheRenewalsOnTheReconnectBackoff() = runTest {
        val world = SessionWorld(kept = token(3600, 1), renewals = listOf(unansweredByTheIssuer(), refusedByTheIssuer()))
        world.session().use { session ->
            session.start()
            session.ready()
            assertNull(session.refresh(session.token.value))
            advanceTimeBy(Timings.RECONNECT_MS * 6 / 5)
            runCurrent()
            assertEquals(2, world.renewed)
            assertFalse(world.isKept())
            assertEquals(listOf(SessionEndReason.EXPIRED), world.told)
            advanceTimeBy(2 * 60 * 60 * 1000L)
            runCurrent()
            assertEquals(2, world.renewed)
        }
    }

    @Test
    fun aSessionThatNeverSignedInCannotExpire() = runTest {
        val world = SessionWorld()
        world.session().use { session ->
            session.start()
            session.ready()
            assertNull(session.refresh(session.token.value))
            assertEquals(1, world.renewed)
            assertEquals(emptyList<SessionEndReason>() to emptyList<Any>(), world.told to world.errors)
        }
    }

    @Test
    fun aSessionGivenNoWayToRenewAsksNothingAndEndsNothing() = runTest {
        val access = token(3600, 1)
        val world = SessionWorld(kept = access)
        world.session(renew = null).use { session ->
            session.start()
            session.ready()
            assertNull(session.refresh(session.token.value))
            assertEquals(access, session.token.value)
            assertTrue(world.isKept())
        }
    }

    // What it says.

    @Test
    fun aSessionsErrorsAreItsOwnAndItsTransportsEachSaidOnce() = runTest {
        val made = TestClient(currentCoroutineContext().minusKey(Job), testScheduler.timeSource)
        val kept = MemorySignIn(HeldSignIn(token(3600, 1), "a-refresh-token", SCRIPT_CLIENT_ID, "https://issuer.test/token", null, null))
        val session = SemiontSession(TARGET, made.client, MutableStateFlow(null), kept, { throw unansweredByTheIssuer() }, { alice }, null, Random(0))
        val said = mutableListOf<SemiontError>()
        val errors = session.errors()
        backgroundScope.launch(Dispatchers.Unconfined) { errors.collect { said += it } }
        session.start()
        session.ready()
        // A request the gateway refused, as the transport reports it, and a renewal that got no answer, as the session does.
        val refused = TransportError.ofStatus("HTTP 503", 503, null)
        made.transport.fail(refused)
        assertNull(session.refresh(session.token.value))
        runCurrent()
        assertEquals(2, said.size, "$said")
        assertEquals(1, said.count { it === refused })
        assertEquals(listOf("session.refresh-exhausted"), said.filterIsInstance<SessionError>().map { it.code })
        made.client.close()
        session.close()
        made.transport.close()
    }

    @Test
    fun aSessionsOwnErrorsAndItsTransportsFailuresAreSaidInTheOrderTheyWereMet() = runTest {
        val made = TestClient(currentCoroutineContext().minusKey(Job), testScheduler.timeSource)
        val session = SemiontSession(TARGET, made.client, MutableStateFlow(null), MemorySignIn(), null, null, null, Random(0))
        val unread = SessionError(SessionErrorCode.KeepFailed, "The sign-in could not be read", TARGET.id)
        val unavailable = TransportError.ofStatus("HTTP 503", 503, null)
        val unsaved = SessionError(SessionErrorCode.SaveRefused, "The storage refused a write of what the client keeps", TARGET.id)
        val refused = unauthorized()
        // Each kind in turn, before anyone reads: all kept for the first reader.
        session.say(unread)
        made.transport.fail(unavailable)
        session.say(unsaved)
        made.transport.fail(refused)
        val said = mutableListOf<SemiontError>()
        val errors = session.errors()
        backgroundScope.launch(Dispatchers.Unconfined) { errors.collect { said += it } }
        runCurrent()
        assertEquals(listOf(unread, unavailable, unsaved, refused), said)
        made.client.close()
        session.close()
        made.transport.close()
    }

    @Test
    fun aSessionNobodyHasReadKeepsTheLatestOfWhatItSaysForItsFirstReader() = runTest {
        val made = TestClient(currentCoroutineContext().minusKey(Job), testScheduler.timeSource)
        val session = SemiontSession(TARGET, made.client, MutableStateFlow(null), MemorySignIn(), null, null, null, Random(0))
        val beyond = 5
        val met: List<SemiontError> = List(Timings.ERRORS_KEPT_FOR_FIRST_READER_COUNT.toInt() + beyond) { n ->
            if (n % 2 == 0) SessionError(SessionErrorCode.KeepFailed, "failure $n", TARGET.id) else TransportError.ofStatus("failure $n", 503, null)
        }
        // Before anyone reads: the session's own as it says them, its transport's as the transport meets them.
        for (error in met) {
            if (error is SessionError) session.say(error) else made.transport.fail(error)
        }
        val said = mutableListOf<SemiontError>()
        val errors = session.errors()
        backgroundScope.launch(Dispatchers.Unconfined) { errors.collect { said += it } }
        runCurrent()
        assertEquals(met.drop(beyond), said)
        made.client.close()
        session.close()
        made.transport.close()
    }

    // How it ends.

    @Test
    fun endingASessionEndsWhatItHoldsAndLeavesItsClientOpen() = runTest {
        val world = SessionWorld(kept = token(300, 1), renewals = listOf(token(300, 2)))
        val session = world.session()
        session.start()
        session.ready()
        session.close()
        // Its client is the caller's, and still carries what is published on it.
        val heard = session.client.bus.framesOn("browse:click", null)
        session.client.bus.emit("browse:click", JsonObject(mapOf("annotationId" to kotlinx.serialization.json.JsonPrimitive("ann-1"))), null, null)
        assertEquals("browse:click", heard.first().channel)
        // Nothing it had scheduled runs, and nothing it is told does anything.
        advanceTimeBy(600_000)
        assertEquals(0, world.renewed)
        assertNull(session.refresh(session.token.value))
        assertEquals(0, world.renewed)
        session.ready()
        val again = assertThrows(IllegalStateException::class.java) { kotlinx.coroutines.runBlocking { session.start() } }
        assertEquals("a session is started once", again.message)
    }

    @Test
    fun aReaderOfAnEndedSessionIsGivenWhatItHeldAndEnds() = runTest {
        val access = token(3600, 1)
        val session = SessionWorld(kept = access).session()
        session.start()
        session.ready()
        session.close()
        assertEquals(listOf(access), withTimeout(1_000) { session.token.toList() })
        assertEquals(listOf(alice), withTimeout(1_000) { session.user.toList() })
    }

    @Test
    fun aSessionEndedWhileItStartsIsReadyAndSaysNothing() = runTest {
        val access = token(3600, 1)
        val world = SessionWorld(kept = access)
        val gateway = Slowly(access, alice)
        val session = world.session(asking = { gateway.validate(it) })
        session.use {
            session.start()
            runCurrent()
            assertEquals(listOf(access), gateway.asked)
        }
        session.ready()
        assertEquals(Triple(0, emptyList<SessionEndReason>(), emptyList<Any>()), Triple(world.renewed, world.told, world.errors))
    }
}
