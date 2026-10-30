package semiont;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Optional;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import java.util.concurrent.LinkedBlockingQueue;
import kotlin.Unit;
import kotlinx.coroutines.flow.FlowKt;
import kotlinx.coroutines.flow.StateFlowKt;
import org.junit.jupiter.api.Test;
import semiont.http.HttpContentTransport;
import semiont.http.HttpTransport;
import semiont.identifiers.AnnotationId;
import semiont.identifiers.ResourceId;
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
import semiont.types.GatheredContext;
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
    void aGatherUnitHoldsWhatItGatheredForJava() throws Exception {
        try (Opened opened = new Opened(); GatherStateUnit unit = new GatherStateUnit(opened.client, new ResourceId("res-1"))) {
            opened.gateway.answer = body -> "{\"channel\":\"gather:complete\",\"payload\":{\"annotationId\":\"ann-1\",\"response\":" + CONTEXT
                    + "},\"correlationId\":\"" + Gateway.correlationOf(body) + "\"}";
            Reading<Optional<GatheredContext>> context = new Reading<>(unit.getContext().asPublisher());
            assertEquals(Optional.empty(), context.next());
            unit.gatherAnnotation(new AnnotationId("ann-1"));
            assertTrue(context.next().isPresent());
            assertEquals(new AnnotationId("ann-1"), unit.getAnnotationId().getValue());
            assertFalse(unit.getLoading().getValue());
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
}
