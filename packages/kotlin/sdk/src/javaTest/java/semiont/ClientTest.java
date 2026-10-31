package semiont;

import static java.nio.charset.StandardCharsets.UTF_8;
import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Flow;
import kotlinx.coroutines.flow.StateFlowKt;
import org.junit.jupiter.api.Test;
import semiont.annotations.AnchorMethod;
import semiont.annotations.AnnotationsKt;
import semiont.annotations.QuotedText;
import semiont.annotations.ReconciledSpan;
import semiont.annotations.TextSpan;
import semiont.bus.Delivered;
import semiont.cache.CacheState;
import semiont.cache.Cached;
import semiont.bus.Typed;
import semiont.channels.Channels;
import semiont.errors.BusRequestError;
import semiont.errors.SpanRefusal;
import semiont.errors.SpanRefusedError;
import semiont.http.HttpContentTransport;
import semiont.http.HttpTransport;
import semiont.identifiers.AnnotationId;
import semiont.identifiers.JobId;
import semiont.identifiers.ResourceId;
import semiont.transport.PutBinaryRequest;
import semiont.transport.Upload;
import semiont.types.AgentSoftware;
import semiont.types.Annotation;
import semiont.types.BeckonHoverEvent;
import semiont.types.GatherAnnotationComplete;
import semiont.types.HighlightingJobParams;
import semiont.types.JobCompleteCommand;
import semiont.types.MarkJobCompleteCommand;
import semiont.types.Motivation;
import semiont.types.TagSchema;

/**
 * The client as a Java program calls it: each shape of what its namespaces
 * return consumed from Java, through a client over a gateway's wire, its
 * content and its own operations; and the annotations module's builders.
 */
final class ClientTest {
    private static final String CONTEXT = "{\"focus\":{\"kind\":\"resource\",\"resource\":{\"@context\":\"https://schema.org\",\"@id\":\"res-1\",\"name\":\"A resource\","
            + "\"representations\":[]}},\"graph\":{\"nodes\":[],\"edges\":[]},\"metadata\":{}}";

    /** A client over a gateway, and what it is over, closed together. */
    private static final class Opened implements AutoCloseable {
        final Gateway gateway = new Gateway();
        // The stream opens once there is a token to open it with.
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

    /** A reply on `channel` to the request an emit's body is. */
    private static String reply(String channel, String payload, String body) {
        return "{\"channel\":\"" + channel + "\",\"payload\":" + payload + ",\"correlationId\":\"" + Gateway.correlationOf(body) + "\"}";
    }

    /** Every item a publisher gives, until it ends. */
    private static <T> CompletableFuture<List<T>> everything(Flow.Publisher<T> publisher) {
        CompletableFuture<List<T>> ended = new CompletableFuture<>();
        List<T> items = new CopyOnWriteArrayList<>();
        publisher.subscribe(new Flow.Subscriber<>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                subscription.request(Long.MAX_VALUE);
            }

            @Override
            public void onNext(T item) {
                items.add(item);
            }

            @Override
            public void onError(Throwable error) {
                ended.completeExceptionally(error);
            }

            @Override
            public void onComplete() {
                ended.complete(items);
            }
        });
        return ended;
    }

    /** The first item a publisher gives. */
    private static <T> CompletableFuture<T> first(Flow.Publisher<T> publisher) {
        CompletableFuture<T> first = new CompletableFuture<>();
        publisher.subscribe(new Flow.Subscriber<>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                subscription.request(1);
            }

            @Override
            public void onNext(T item) {
                first.complete(item);
            }

            @Override
            public void onError(Throwable error) {
                first.completeExceptionally(error);
            }

            @Override
            public void onComplete() {}
        });
        return first;
    }

    @Test
    void aPromiseIsAFutureAndTheYieldNamespaceIsAQualifiedCall() throws Exception {
        try (Opened opened = new Opened()) {
            opened.gateway.answer = body -> reply("frame:entity-type-add-ok", "{}", body);
            opened.client.getFrame().addEntityTypeFuture("Person").get(10, SECONDS);
            assertTrue(opened.gateway.next().contains("\"tag\":\"Person\""));
            // Java's contextual `yield` is a statement's, and a namespace reached through its getter is no statement.
            assertNotNull(opened.client.getYield());
        }
    }

    @Test
    void aDriveSaysHowManyItReachedAndASignalReachesTheClientsOwnBus() throws Exception {
        try (Opened opened = new Opened()) {
            Long reached = opened.client.getBeckon().attentionFuture(new ResourceId("res-1"), new AnnotationId("ann-1")).get(10, SECONDS);
            assertEquals(1L, reached);
            try (Typed<BeckonHoverEvent> hovers = opened.client.getBus().frames(Channels.BECKON_HOVER, null)) {
                CompletableFuture<Delivered<BeckonHoverEvent>> hovered = first(hovers.asPublisher());
                opened.client.getBeckon().hover(new AnnotationId("ann-1"));
                assertEquals(new AnnotationId("ann-1"), hovered.get(10, SECONDS).getPayload().getAnnotationId());
            }
        }
    }

    @Test
    void anEventIsReadThroughItsPublisher() throws Exception {
        try (Opened opened = new Opened(); Typed<JobCompleteCommand> completions = opened.client.getJob().complete()) {
            CompletableFuture<Delivered<JobCompleteCommand>> completed = first(completions.asPublisher());
            opened.gateway.send("{\"channel\":\"job:complete\",\"payload\":{\"resourceId\":\"res-1\",\"jobId\":\"job-1\",\"jobType\":\"mark\"}}");
            assertEquals(new JobId("job-1"), assertInstanceOf(MarkJobCompleteCommand.class, completed.get(10, SECONDS).getPayload()).getJobId());
        }
    }

    @Test
    void aRunningOperationIsAwaitedOrReadFromJava() throws Exception {
        try (Opened opened = new Opened()) {
            opened.gateway.answer = body -> reply("gather:complete", "{\"annotationId\":\"ann-1\",\"response\":" + CONTEXT + "}", body);
            GatherAnnotationComplete awaited = opened.client.getGather().annotation(new ResourceId("res-1"), new AnnotationId("ann-1")).awaitFuture().get(10, SECONDS);
            assertEquals(new AnnotationId("ann-1"), awaited.getAnnotationId());
            List<GatherAnnotationComplete> read = everything(opened.client.getGather().annotation(new ResourceId("res-1"), new AnnotationId("ann-1")).asPublisher()).get(10, SECONDS);
            assertEquals(List.of(awaited), read);
        }
    }

    @Test
    void aDelegationIsFollowedFromJava() throws Exception {
        try (Opened opened = new Opened()) {
            opened.gateway.answer = body -> body.contains("\"channel\":\"job:create\"") ? reply("job:created", "{\"response\":{\"jobId\":\"job-1\"}}", body) : null;
            CompletableFuture<List<JobEvent<MarkJobCompleteCommand>>> events =
                    everything(opened.client.getMark().delegate(new ResourceId("res-1"), HighlightingJobParams.builder().build()).asPublisher());
            assertTrue(opened.gateway.next().contains("\"jobType\":\"mark\""));
            opened.gateway.send("{\"channel\":\"job:complete\",\"payload\":{\"resourceId\":\"res-1\",\"jobId\":\"job-1\",\"jobType\":\"mark\"}}");
            List<JobEvent<MarkJobCompleteCommand>> followed = events.get(10, SECONDS);
            assertEquals(List.of("created", "complete"), followed.stream().map(JobEvent::getKind).toList());
            assertEquals(new JobId("job-1"), assertInstanceOf(JobCreated.class, followed.get(0)).getData().getJobId());

            CompletableFuture<MarkJobCompleteCommand> awaited = opened.client.getMark().delegate(new ResourceId("res-1"), HighlightingJobParams.builder().build()).awaitFuture();
            opened.gateway.next();
            opened.gateway.send("{\"channel\":\"job:complete\",\"payload\":{\"resourceId\":\"res-1\",\"jobId\":\"job-1\",\"jobType\":\"mark\"}}");
            assertEquals(new ResourceId("res-1"), awaited.get(10, SECONDS).getResourceId());
        }
    }

    @Test
    void anUploadAndAResourcesTextAreHadFromJava() throws Exception {
        try (Opened opened = new Opened()) {
            PutBinaryRequest request = PutBinaryRequest.builder("Notes", "the bytes".getBytes(UTF_8), "text/plain", "file://notes.txt").build();
            try (Upload upload = opened.client.getYield().resource(request)) {
                assertEquals(new ResourceId("res-2"), upload.awaitFuture().get(10, SECONDS).getResourceId());
            }
            assertEquals("the bytes", opened.client.getBrowse().resourceContentFuture(new ResourceId("res-1")).get(10, SECONDS));
        }
    }

    @Test
    void aCloneIsMadeFromItsTokenFromJava() throws Exception {
        try (Opened opened = new Opened()) {
            String source = "{\"@context\":\"https://schema.org\",\"@id\":\"res-1\",\"name\":\"A resource\",\"representations\":[{\"mediaType\":\"text/markdown\"}]}";
            opened.gateway.answer = body -> reply("yield:clone-resource-result", "{\"response\":{\"sourceResource\":" + source + ",\"expiresAt\":\"2030-01-01T00:00:00.000Z\"}}", body);
            assertEquals(new ResourceId("res-2"), opened.client.getYield().createFromTokenFuture("tok-1", "A Copy", "hello").get(10, SECONDS).getResourceId());
            String sent = new String(opened.gateway.uploaded.get(10, SECONDS), UTF_8);
            assertTrue(sent.contains("file://a-copy.md") && sent.contains("text/markdown") && sent.contains("tok-1"), sent);
        }
    }

    @Test
    void aQuoteIsReconciledAndItsAnnotationBuiltFromJava() {
        String text = "Ada Lovelace wrote the first algorithm.";
        ReconciledSpan found = AnnotationsKt.reconcile(text, new QuotedText("Lovelace"));
        assertNotNull(found);
        assertSame(AnchorMethod.UniqueMatch.INSTANCE, found.getAnchorMethod());
        Annotation built = AnnotationsKt.annotationOfSpan(text, found.getSpan(), new ResourceId("res-1"), Motivation.Highlighting, AgentSoftware.builder().name("gemma3").build());
        assertEquals("Lovelace", AnnotationsKt.annotationExactText(built));
        SpanRefusedError refused = assertThrows(SpanRefusedError.class,
                () -> AnnotationsKt.annotationOfSpan(text, new TextSpan(0, 99, "Ada"), new ResourceId("res-1"), Motivation.Highlighting, AgentSoftware.builder().name("gemma3").build()));
        assertEquals(SpanRefusal.SpanOutOfRange, refused.getReason());
    }

    @Test
    void aLiveQueryIsReadThroughItsPublisherAndItsStatesAreValuesJavaTellsApart() throws Exception {
        try (Opened opened = new Opened()) {
            opened.gateway.answer = body -> {
                if (body.contains("\"channel\":\"browse:entity-types-requested\"")) return reply("browse:entity-types-result", "{\"response\":{\"entityTypes\":[\"Person\"]}}", body);
                if (body.contains("\"channel\":\"browse:tag-schemas-requested\"")) return reply("browse:tag-schemas-failed", "{\"message\":\"no schemas here\"}", body);
                return null;
            };
            Cached<List<String>> types = opened.client.getBrowse().entityTypes();
            List<String> seen = new CopyOnWriteArrayList<>();
            CompletableFuture<List<String>> value = new CompletableFuture<>();
            types.asPublisher().subscribe(new Flow.Subscriber<>() {
                @Override
                public void onSubscribe(Flow.Subscription subscription) {
                    subscription.request(Long.MAX_VALUE);
                }

                @Override
                public void onNext(CacheState<List<String>> state) {
                    // The three states are values: Java tells them apart by their classes.
                    if (state instanceof CacheState.Pending) {
                        seen.add("pending");
                    } else if (state instanceof CacheState.Ready<List<String>> ready) {
                        seen.add("ready");
                        value.complete(ready.getValue());
                    } else if (state instanceof CacheState.Failed failed) {
                        seen.add("failed");
                        value.completeExceptionally(failed.getError());
                    }
                }

                @Override
                public void onError(Throwable error) {
                    value.completeExceptionally(error);
                }

                @Override
                public void onComplete() {}
            });
            assertEquals(List.of("Person"), value.get(10, SECONDS));
            assertEquals(List.of("pending", "ready"), seen);
            assertEquals(List.of("Person"), types.freshFuture().get(10, SECONDS));

            // A failure is a state, given after the query's one retry has failed too.
            CompletableFuture<CacheState.Failed> failed = new CompletableFuture<>();
            opened.client.getBrowse().tagSchemas().asPublisher().subscribe(new Flow.Subscriber<>() {
                @Override
                public void onSubscribe(Flow.Subscription subscription) {
                    subscription.request(Long.MAX_VALUE);
                }

                @Override
                public void onNext(CacheState<List<TagSchema>> state) {
                    if (state instanceof CacheState.Failed failure) failed.complete(failure);
                }

                @Override
                public void onError(Throwable error) {
                    failed.completeExceptionally(error);
                }

                @Override
                public void onComplete() {}
            });
            assertEquals("bus.rejected", assertInstanceOf(BusRequestError.class, failed.get(10, SECONDS).getError()).getCode());
        }
    }
}
