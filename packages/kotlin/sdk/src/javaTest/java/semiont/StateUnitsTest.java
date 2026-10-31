package semiont;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Flow;
import java.util.concurrent.LinkedBlockingQueue;
import kotlin.Unit;
import kotlinx.coroutines.flow.FlowKt;
import kotlinx.coroutines.flow.StateFlowKt;
import kotlinx.serialization.json.Json;
import kotlinx.serialization.json.JsonElementKt;
import org.junit.jupiter.api.Test;
import semiont.cache.Cache;
import semiont.cache.CacheState;
import semiont.errors.BusRequestError;
import semiont.errors.BusRequestErrorCode;
import semiont.http.HttpContentTransport;
import semiont.http.HttpTransport;
import semiont.identifiers.AnnotationId;
import semiont.identifiers.ResourceId;
import semiont.errors.SemiontError;
import semiont.session.KbIdentityConflict;
import semiont.session.PermissionDenied;
import semiont.session.SemiontSession;
import semiont.session.SessionEndReason;
import semiont.session.SessionSignals;
import semiont.state.BeckonStateUnit;
import semiont.state.GatherStateUnit;
import semiont.state.HoverDwell;
import semiont.state.MarkStateUnit;
import semiont.state.MatchStateUnit;
import semiont.state.SearchPipeline;
import semiont.state.SearchState;
import semiont.state.YieldStateUnit;
import semiont.testing.FaultyTransport;
import semiont.testing.TestClient;
import semiont.testing.TestSession;
import semiont.testing.TestSessionKt;
import semiont.testing.TestSessionOptions;
import semiont.transport.Events;
import semiont.types.GatheredContext;
import semiont.types.GenerationJobParams;
import semiont.types.HighlightingJobParams;

/**
 * The state units as a Java program uses them: each made and moved from Java,
 * its states read as publishers of `Optional`s, and closed with
 * try-with-resources, which ends every reader.
 */
final class StateUnitsTest {
    private static final String CONTEXT = "{\"focus\":{\"kind\":\"resource\",\"resource\":{\"@context\":\"https://schema.org\",\"@id\":\"res-1\",\"name\":\"A resource\","
            + "\"representations\":[]}},\"graph\":{\"nodes\":[],\"edges\":[]},\"metadata\":{}}";

    /** A client over a gateway, and what it is over, closed together. */
    private static final class Opened implements AutoCloseable {
        final Gateway gateway = new Gateway();
        final HttpTransport transport = new HttpTransport(gateway.origin(), StateFlowKt.<String>MutableStateFlow("token"));
        final HttpContentTransport content = new HttpContentTransport(transport);
        final SemiontClient client = new SemiontClient(transport, content, transport);

        Opened() throws Exception {}

        @Override
        public void close() {
            client.close();
            content.close();
            transport.close();
            gateway.close();
        }
    }

    /** What a publisher gives, one at a time, and whether it has ended. */
    private static final class Reading<T> {
        private final BlockingQueue<Optional<T>> given = new LinkedBlockingQueue<>();
        final CompletableFuture<Void> ended = new CompletableFuture<>();

        Reading(Flow.Publisher<T> publisher) {
            publisher.subscribe(new Flow.Subscriber<>() {
                @Override
                public void onSubscribe(Flow.Subscription subscription) {
                    subscription.request(Long.MAX_VALUE);
                }

                @Override
                public void onNext(T item) {
                    given.add(Optional.of(item));
                }

                @Override
                public void onError(Throwable error) {
                    ended.completeExceptionally(error);
                }

                @Override
                public void onComplete() {
                    ended.complete(null);
                }
            });
        }

        /** The next thing given, waiting a while for it. */
        T next() throws InterruptedException {
            Optional<T> item = given.poll(10, SECONDS);
            if (item == null) throw new AssertionError("nothing was given");
            return item.get();
        }
    }

    @Test
    void theSessionsSignalsAreRaisedReadAndClosedFromJava() throws Exception {
        Reading<Optional<semiont.session.SessionEnded>> ended;
        try (SessionSignals signals = new SessionSignals()) {
            ended = new Reading<>(signals.getSessionEnded().asPublisher());
            assertEquals(Optional.empty(), ended.next());
            signals.notifySessionEnded(SessionEndReason.EXPIRED);
            assertEquals(SessionEndReason.EXPIRED, ended.next().orElseThrow().getReason());
        }
        ended.ended.get(10, SECONDS);
    }

    @Test
    void aBeckonUnitHoldsWhatIsHoveredAndIsClosedFromJava() throws Exception {
        try (Opened opened = new Opened()) {
            Reading<Optional<AnnotationId>> hovered;
            try (BeckonStateUnit unit = new BeckonStateUnit(opened.client, new ResourceId("res-1"))) {
                hovered = new Reading<>(unit.getHoveredAnnotationId().asPublisher());
                assertEquals(Optional.empty(), hovered.next());
                opened.client.getBeckon().hover(new AnnotationId("ann-1"));
                assertEquals(Optional.of(new AnnotationId("ann-1")), hovered.next());
                unit.focus(new AnnotationId("ann-1"));
            }
            hovered.ended.get(10, SECONDS);
        }
    }

    @Test
    void aDwellSaysWhatThePointerRestedOnToAJavaCallback() throws Exception {
        BlockingQueue<Optional<AnnotationId>> said = new LinkedBlockingQueue<>();
        try (HoverDwell dwell = new HoverDwell(annotationId -> {
            said.add(Optional.ofNullable(annotationId));
            return Unit.INSTANCE;
        }, 10)) {
            dwell.enter(new AnnotationId("ann-1"));
            assertEquals(Optional.of(new AnnotationId("ann-1")), said.poll(10, SECONDS));
            dwell.leave();
            assertEquals(Optional.empty(), said.poll(10, SECONDS));
        }
    }

    @Test
    void aSearchPipelineSearchesWithWhatJavaGivesIt() throws Exception {
        try (SearchPipeline<String> pipeline = new SearchPipeline<>(query -> FlowKt.flowOf(List.of(query.toUpperCase())), 10)) {
            Reading<Optional<SearchState<String>>> states = new Reading<>(pipeline.getState().asPublisher());
            assertEquals(new SearchState<String>(List.of(), false), states.next().orElseThrow());
            pipeline.setQuery("paris");
            SearchState<String> found = states.next().orElseThrow();
            while (found.isSearching()) found = states.next().orElseThrow();
            assertEquals(List.of("PARIS"), found.getResults());
            assertEquals("paris", pipeline.getQuery().getValue());
        }
    }

    @Test
    void aCacheJavaMakesAsksWhatJavaGivesItAndIsClosedFromJava() throws Exception {
        // Each answer is how many requests have been made, so every request shows.
        List<String> asked = new CopyOnWriteArrayList<>();
        Reading<CacheState<Integer>> states;
        try (Cache<String, Integer> cache = new Cache<String, Integer>(key -> {
            asked.add(key);
            return CompletableFuture.completedFuture(asked.size());
        })) {
            assertEquals(1, cache.fetchFuture("k").get(10, SECONDS));
            assertEquals(1, cache.get("k"));
            assertTrue(cache.known("k"));
            assertFalse(cache.known("other"));
            assertEquals(List.of("k"), cache.keys());
            states = new Reading<>(cache.observe("k").asPublisher());
            assertEquals(new CacheState.Ready<>(1), states.next());
            cache.set("k", 10);
            assertEquals(new CacheState.Ready<>(10), states.next());
            BusRequestError gone = new BusRequestError(BusRequestErrorCode.NotFound, "gone", null);
            cache.remove("k", gone);
            assertEquals(new CacheState.Failed(gone), states.next());
            cache.invalidate("k");
            assertEquals(new CacheState.Ready<>(2), readyOf(states));
            cache.invalidateAll();
            assertEquals(new CacheState.Ready<>(3), readyOf(states));
            assertEquals(List.of("k", "k", "k"), asked);
            assertFalse(cache.getPersistencePending());
        }
        states.ended.get(10, SECONDS);
    }

    /** The next state of a cache's key that has a value, past any that has none. */
    private static CacheState<Integer> readyOf(Reading<CacheState<Integer>> states) throws InterruptedException {
        CacheState<Integer> state = states.next();
        while (!(state instanceof CacheState.Ready<?>)) state = states.next();
        return state;
    }

    @Test
    void aGatherUnitHoldsWhatItGatheredForJava() throws Exception {
        try (Opened opened = new Opened(); GatherStateUnit unit = new GatherStateUnit(opened.client, new ResourceId("res-1"))) {
            opened.gateway.answer = body -> "{\"channel\":\"gather:complete\",\"payload\":{\"annotationId\":\"ann-1\",\"response\":" + CONTEXT
                    + "},\"correlationId\":\"" + Gateway.correlationOf(body) + "\"}";
            Reading<Optional<GatheredContext>> context = new Reading<>(unit.getContext().asPublisher());
            assertEquals(Optional.empty(), context.next());
            unit.gatherAnnotation(new AnnotationId("ann-1"));
            assertTrue(context.next().isPresent());
            assertEquals(new AnnotationId("ann-1"), unit.getAnnotationId().getValue());
            // The context is held before the gather is said to be over, so a reader told of it may still find it loading.
            Reading<Optional<Boolean>> loading = new Reading<>(unit.getLoading().asPublisher());
            while (loading.next().orElseThrow()) {}
            assertNull(unit.getError().getValue());
        }
    }

    @Test
    void theJobUnitsAreMadeMovedAndClosedFromJava() throws Exception {
        try (Opened opened = new Opened()) {
            Reading<Optional<semiont.types.Motivation>> delegating;
            // A unit with no state is still closed: what it runs ends, and closing it again does nothing more.
            MatchStateUnit matching = new MatchStateUnit(opened.client);
            matching.close();
            matching.close();
            try (MarkStateUnit mark = new MarkStateUnit(opened.client, new ResourceId("res-1"));
                    YieldStateUnit yielding = new YieldStateUnit(opened.client, "en")) {
                delegating = new Reading<>(mark.getDelegatingMotivation().asPublisher());
                assertEquals(Optional.empty(), delegating.next());
                mark.requestDelegate(HighlightingJobParams.builder().build());
                assertEquals(Optional.of(semiont.types.Motivation.Highlighting), delegating.next());
                mark.cancelPending();
                mark.dismissProgress();
                yielding.dismissProgress();
                assertFalse(yielding.isGenerating().getValue());
            }
            delegating.ended.get(10, SECONDS);
        }
    }

    @Test
    void whatAUnitHoldsIsReadFromJavaAndAFailedRunIsHeld() throws Exception {
        FaultyTransport transport = new FaultyTransport();
        SemiontClient client = new TestClient(transport).getClient();
        ResourceId resource = new ResourceId("res-1");
        transport.queueReply("gather:requested", List.of(JsonElementKt.getJsonObject(Json.Default.parseToJsonElement(CONTEXT))));
        GatheredContext context = client.getGather().annotation(resource, new AnnotationId("ann-1")).awaitFuture().get(10, SECONDS).getResponse();
        try (GatherStateUnit gather = new GatherStateUnit(client, resource);
                MarkStateUnit mark = new MarkStateUnit(client, resource);
                YieldStateUnit yielding = new YieldStateUnit(client, "en")) {
            // Nobody scripted these requests, so each is refused, and the unit holds why.
            Reading<Optional<SemiontError>> gatherFailed = new Reading<>(gather.getResourceError().asPublisher());
            assertEquals(Optional.empty(), gatherFailed.next());
            assertNull(gather.getResourceContext().getValue());
            gather.gatherResource(resource);
            while (gatherFailed.next().isEmpty()) {}
            // The failure is held before the gather is said to be over.
            Reading<Optional<Boolean>> resourceLoading = new Reading<>(gather.getResourceLoading().asPublisher());
            while (resourceLoading.next().orElseThrow()) {}

            assertNull(mark.getPendingAnnotation().getValue());
            assertNull(mark.getProgress().getValue());
            assertNull(mark.getProgressMotivation().getValue());
            assertNull(mark.getFailure().getValue());
            assertNull(mark.getJobId().getValue());

            Reading<Optional<SemiontError>> yieldFailed = new Reading<>(yielding.getFailure().asPublisher());
            assertEquals(Optional.empty(), yieldFailed.next());
            yielding.generate(GenerationJobParams.builder("A summary", "file://summary.md", context).build());
            assertTrue(yieldFailed.next().isPresent());
            assertNull(yielding.getProgress().getValue());
            assertNull(yielding.getOutcome().getValue());
            assertNull(yielding.getJobId().getValue());
        }
        client.close();
        transport.close();
    }

    @Test
    void theSessionsOtherSignalsAreRaisedAndAcknowledgedFromJava() throws Exception {
        try (SessionSignals signals = new SessionSignals()) {
            Reading<Optional<PermissionDenied>> denied = new Reading<>(signals.getPermissionDenied().asPublisher());
            assertEquals(Optional.empty(), denied.next());
            signals.notifyPermissionDenied("You may not delete this");
            assertEquals(Optional.of(new PermissionDenied("You may not delete this")), denied.next());
            signals.acknowledgePermissionDenied();
            assertEquals(Optional.empty(), denied.next());

            signals.notifyKbIdentityConflict(new KbIdentityConflict("did:web:kb.example", "did:web:other.example"));
            assertEquals("did:web:other.example", signals.getKbIdentityConflict().getValue().getObservedDid());
            signals.acknowledgeKbIdentityConflict();
            assertNull(signals.getKbIdentityConflict().getValue());
        }
    }

    @Test
    void aSessionIsReadFromJava() throws Exception {
        TestSession made = TestSessionKt.createTestSessionFuture(new TestSessionOptions()).get(10, SECONDS);
        SemiontSession session = made.getSession();
        session.readyFuture().get(10, SECONDS);
        assertNotNull(session.getId());
        assertNotNull(session.getKb());
        assertEquals(made.getClient(), session.getClient());
        assertNull(session.getUser().getValue());
        assertNotNull(session.getStreamState().getValue());
        assertNull(session.expiresAt());
        try (Events<SemiontError> errors = session.errors()) {
            assertNotNull(errors.asPublisher());
        }
        // Nothing is kept to renew, so a refresh gives no token.
        assertNull(session.refreshFuture().get(10, SECONDS));
        session.close();
        made.getClient().close();
        made.getTransport().close();
    }
}
