package semiont;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import kotlinx.serialization.json.JsonElement;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import org.junit.jupiter.api.Test;
import semiont.bus.BusKt;
import semiont.bus.Operations;
import semiont.testing.DeliverySubject;
import semiont.testing.DropReply;
import semiont.testing.FaultAction;
import semiont.testing.FaultyTransport;
import semiont.testing.LivenessKt;
import semiont.testing.LivenessScenario;
import semiont.testing.LivenessSpec;
import semiont.testing.ScriptedSessions;
import semiont.testing.SharedStorage;
import semiont.testing.TestClient;
import semiont.testing.TestSession;
import semiont.testing.TestSessionKt;
import semiont.testing.TestSessionOptions;

/**
 * The testing module as a Java program's tests use it: doubles scripted from
 * Java, a test session and scripted sessions through their futures, and both
 * liveness harnesses run against subjects written in Java.
 */
final class TestingTest {
    private static JsonObject object(String name, String value) {
        return new JsonObject(Map.<String, JsonElement>of(name, JsonElementKt.JsonPrimitive(value)));
    }

    @Test
    void aJavaTestScriptsTheTransportAndReadsWhatWasAsked() throws Exception {
        FaultyTransport transport = new FaultyTransport();
        TestClient made = new TestClient(transport);
        transport.queueReply("browse:kb-requested", List.of(object("name", "A KB")));
        JsonObject answered = BusKt.requestFuture(made.getClient().getTransport(), Operations.BROWSE_KB_REQUESTED, new JsonObject(Map.of()), 5_000).get(10, SECONDS);
        assertEquals(object("name", "A KB"), answered.get("response"));
        assertEquals("browse:kb-requested", transport.getRequestLog().get(0).getChannel());
        made.getClient().close();
        transport.close();
    }

    @Test
    void aJavaTestHoldsATestSessionAndScriptedSessions() throws Exception {
        TestSession session = TestSessionKt.createTestSessionFuture(new TestSessionOptions()).get(10, SECONDS);
        assertNull(session.getSession().getToken().getValue());
        session.setToken("a-token");
        assertEquals("a-token", session.getSession().getToken().getValue());
        session.getSession().close();
        session.getClient().close();
        session.getTransport().close();

        ScriptedSessions sessions = new ScriptedSessions((kbId, operation, payload) -> object("kb", kbId));
        sessions.queueRenewals("renewed");
        assertTrue(sessions.transports("kb-a").isEmpty());
        assertEquals(0, sessions.getRenewed());
        SharedStorage storage = new SharedStorage();
        List<String> heard = new ArrayList<>();
        storage.context().subscribe((key, value) -> {
            heard.add(key + "=" + value);
            return kotlin.Unit.INSTANCE;
        });
        storage.set("k", "v");
        assertEquals(List.of("k=v"), heard);
    }

    @Test
    void aJavaCompositionIsHeldToTheLivenessAxioms() {
        List<List<FaultAction>> dropped = List.of(List.of(DropReply.INSTANCE));
        LivenessSpec silent = new LivenessSpec(transport -> new LivenessScenario(List.of(new CompletableFuture<Void>())), 20, 1, dropped);
        AssertionError caught = assertThrows(AssertionError.class, () -> LivenessKt.assertLivenessAxioms(silent));
        assertTrue(caught.getMessage().startsWith("L1: output #0 said nothing"), caught.getMessage());

        class Connection implements DeliverySubject {
            final List<String> delivered = new ArrayList<>();

            @Override
            public void write(String eventId) {
                delivered.add(eventId);
            }

            @Override
            public void transition() {}

            @Override
            public List<String> delivered() {
                return delivered;
            }
        }
        LivenessKt.assertExactlyOnceDelivery(Connection::new, LivenessKt.deliveryOps(20, 12, new Random(3)));
    }
}
