package semiont;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertArrayEquals;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import kotlinx.serialization.json.JsonElement;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import org.junit.jupiter.api.Test;
import semiont.bus.BusKt;
import semiont.bus.Operations;
import semiont.identifiers.ResourceId;
import semiont.testing.DeliveryOp;
import semiont.testing.DeliverySubject;
import semiont.testing.DropReply;
import semiont.testing.FaultAction;
import semiont.testing.FaultyTransport;
import semiont.testing.InMemoryContent;
import semiont.testing.LivenessKt;
import semiont.testing.LivenessScenario;
import semiont.testing.LivenessSpec;
import semiont.testing.ScriptedSessions;
import semiont.testing.SharedStorage;
import semiont.testing.StubGateway;
import semiont.testing.TestClient;
import semiont.testing.TestSession;
import semiont.testing.TestSessionKt;
import semiont.testing.TestSessionOptions;
import semiont.transport.Content;
import semiont.transport.Frame;
import semiont.transport.PendingReply;
import semiont.transport.ResourceHold;

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
        assertEquals(List.of(DeliveryOp.WRITE, DeliveryOp.TRANSITION), List.of(DeliveryOp.values()));
    }

    @Test
    void aJavaTestAnswersWhatNobodyQueuedAndDrawsItsFaults() throws Exception {
        FaultyTransport transport = new FaultyTransport(List.of(), (operation, payload) -> object("answered", operation));
        TestClient made = new TestClient(transport);
        JsonObject answered = BusKt.requestFuture(made.getClient().getTransport(), Operations.BROWSE_KB_REQUESTED, new JsonObject(Map.of()), 5_000).get(10, SECONDS);
        assertEquals(object("answered", "browse:kb-requested"), answered.get("response"));
        made.getClient().close();
        transport.close();

        assertTrue(LivenessKt.faultActions(new Random(1)) instanceof FaultAction);
        List<List<FaultAction>> schedules = LivenessKt.faultSchedules(3, new Random(1));
        assertEquals(3, schedules.size());
    }

    @Test
    void theDoublesTwinsAreCalledFromJava() throws Exception {
        ResourceId resource = new ResourceId("res-1");
        InMemoryContent content = new InMemoryContent();
        content.seed(resource, new Content("text/plain", "the bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        assertArrayEquals("the bytes".getBytes(java.nio.charset.StandardCharsets.UTF_8), content.getBinaryFuture(resource).get(10, SECONDS).getBytes());
        assertEquals("text/plain", content.getBinaryStreamFuture(resource).get(10, SECONDS).getContentType());
        // What nobody stored is not found, never read as nothing.
        assertThrows(ExecutionException.class, () -> content.getBinaryFuture(new ResourceId("res-2")).get(10, SECONDS));
        assertThrows(ExecutionException.class, () -> content.getResourceGraphFuture(resource).get(10, SECONDS));
        assertThrows(ExecutionException.class, () -> content.getAnnotationsFuture(resource).get(10, SECONDS));
        assertThrows(ExecutionException.class, () -> content.getAnchoredTextFuture(resource).get(10, SECONDS));
        assertEquals(6, content.getCalls().size());

        StubGateway gateway = new StubGateway();
        assertThrows(ExecutionException.class, () -> gateway.getMediaTokenFuture(resource).get(10, SECONDS));
        assertEquals(List.of("getMediaToken res-1"), gateway.getCalls());

        FaultyTransport transport = new FaultyTransport();
        transport.emitFuture("beckon:sparkle", object("annotationId", "ann-1"), resource, null).get(10, SECONDS);
        assertEquals(resource, transport.getEmitted().get(0).getScope());
        ResourceHold hold = transport.subscribeToResource(resource);
        assertEquals(1, transport.holds(resource));
        hold.close();
        assertEquals(0, transport.holds(resource));
        try (PendingReply pending = transport.trackReply("c-1", List.of("browse:kb-result"))) {
            CompletableFuture<Frame> reply = pending.frameFuture();
            transport.deliver(new Frame("browse:kb-result", object("response", "A KB"), "c-1", (ResourceId) null, null));
            assertEquals("c-1", reply.get(10, SECONDS).getCorrelationId());
        }
        transport.close();
    }
}
