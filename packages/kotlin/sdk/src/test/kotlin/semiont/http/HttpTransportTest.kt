package semiont.http

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import semiont.identifiers.ResourceId
import semiont.transport.ConnectionState

/** A transport's stream: opened once there is a token and something to carry. */
class HttpTransportTest {
    @Test
    fun aTransportThatCarriesNothingOpensNoStreamUntilAScopeGivesItSomething() = runBlocking {
        Realm().use { realm ->
            HttpTransport(realm.origin, MutableStateFlow("token"), emptyList(), Timing(reconnectMs = 10, lazyRemoveMs = 10, lingerMs = 10)).use { transport ->
                // Held only for the gateway's own operations, or to ask who a token is: no request of the bus.
                delay(300)
                assertEquals(emptyList<String>(), realm.of("/bus/subscribe").map { it.path })
                assertEquals(ConnectionState.Initial, transport.state.value)
                transport.subscribeToResource(ResourceId("res-1")).use {
                    withTimeout(5_000) {
                        while (realm.of("/bus/subscribe").isEmpty()) delay(5)
                    }
                }
            }
        }
    }
}
