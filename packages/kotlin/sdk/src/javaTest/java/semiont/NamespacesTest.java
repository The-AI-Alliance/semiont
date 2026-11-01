package semiont;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import kotlinx.serialization.json.Json;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import semiont.bus.Delivered;
import semiont.bus.Heard;
import semiont.bus.Typed;
import semiont.errors.SemiontError;
import semiont.channels.Channels;
import semiont.identifiers.AnnotationId;
import semiont.identifiers.JobId;
import semiont.identifiers.ResourceId;
import semiont.testing.ContentCall;
import semiont.testing.FaultyTransport;
import semiont.testing.GetAnchoredText;
import semiont.testing.GetBinary;
import semiont.testing.GetBinaryStream;
import semiont.testing.GetResourceGraph;
import semiont.testing.InMemoryContent;
import semiont.testing.RequestLogEntry;
import semiont.testing.StubGateway;
import semiont.testing.TestClient;
import semiont.transport.Events;
import semiont.transport.Frame;
import semiont.types.AnnotationTarget;
import semiont.types.BeckonSparkleEvent;
import semiont.types.BindInitiateCommand;
import semiont.types.BrowseDirectoryRequestSort;
import semiont.types.CreateAnnotationRequest;
import semiont.types.GatheredContext;
import semiont.types.JobFailCommand;
import semiont.types.JobQueuedEvent;
import semiont.types.JobReportProgressCommand;
import semiont.types.MarkJobQueuedEvent;
import semiont.types.MarkSubmitEvent;
import semiont.types.MatchSearchRequest;
import semiont.types.Motivation;
import semiont.types.ResourceErrorEvent;
import semiont.types.TagSchema;
import semiont.types.TextQuoteSelector;

/**
 * Every method of every namespace, called as a Java program calls it, over
 * the testing module's doubles: what each asks of the knowledge base, reads
 * of its content or its gateway, sends over the wire, or says on the
 * client's own bus. A request nobody scripted is refused, which is enough to
 * show what was asked.
 */
final class NamespacesTest {
    private static final ResourceId RESOURCE = new ResourceId("res-1");
    private static final AnnotationId ANNOTATION = new AnnotationId("ann-1");
    private static final JobId JOB = new JobId("job-1");
    private static final String CONTEXT = "{\"focus\":{\"kind\":\"resource\",\"resource\":{\"@context\":\"https://schema.org\",\"@id\":\"res-1\",\"name\":\"A resource\","
            + "\"representations\":[]}},\"graph\":{\"nodes\":[],\"edges\":[]},\"metadata\":{}}";

    private final FaultyTransport transport = new FaultyTransport();
    private final InMemoryContent content = new InMemoryContent();
    private final StubGateway gateway = new StubGateway();
    private final SemiontClient client = new TestClient(transport, content, gateway).getClient();

    @AfterEach
    void close() {
        client.close();
        transport.close();
    }

    private static JsonObject json(String text) {
        return JsonElementKt.getJsonObject(Json.Default.parseToJsonElement(text));
    }

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

    /** What a typed read heard, as the frame it is: a refusal fails the test. */
    private static <P> Delivered<P> delivered(Heard<P> heard) {
        if (heard instanceof Delivered<P> frame) {
            return frame;
        }
        throw new AssertionError("refused: " + heard);
    }

    /** Wait for `call` to settle: with a value, or refused with a failure the SDK names. */
    private static void settle(CompletableFuture<?> call) throws Exception {
        try {
            call.get(10, SECONDS);
        } catch (ExecutionException refused) {
            assertInstanceOf(SemiontError.class, refused.getCause());
        }
    }

    /** The channel `call` asked on, once it has settled either way. */
    private String asked(CompletableFuture<?> call) throws Exception {
        settle(call);
        List<RequestLogEntry> log = transport.getRequestLog();
        assertFalse(log.isEmpty(), "nothing was asked");
        return log.get(log.size() - 1).getChannel();
    }

    /** What `call` read of the content, once it has settled either way. */
    private ContentCall read(CompletableFuture<?> call) throws Exception {
        settle(call);
        List<ContentCall> calls = content.getCalls();
        return calls.get(calls.size() - 1);
    }

    /** The gateway's operation `call` called, once it has settled either way. */
    private String called(CompletableFuture<?> call) throws Exception {
        settle(call);
        List<String> calls = gateway.getCalls();
        return calls.get(calls.size() - 1);
    }

    /** The frame `signal` says on the client's own bus. */
    private Frame said(String channel, Runnable signal) throws Exception {
        try (Events<Frame> frames = client.getBus().framesAmong(List.of(channel))) {
            CompletableFuture<Frame> said = first(frames.asPublisher());
            signal.run();
            return said.get(10, SECONDS);
        }
    }

    /** Whether a frame on `channel` has gone over the wire, waiting up to ten seconds for it. */
    private boolean sent(String channel) throws InterruptedException {
        long until = System.currentTimeMillis() + 10_000;
        while (System.currentTimeMillis() < until) {
            if (transport.getEmitted().stream().anyMatch(frame -> frame.getChannel().equals(channel))) return true;
            Thread.sleep(10);
        }
        return false;
    }

    private GatheredContext gathered() throws Exception {
        transport.queueReply("gather:requested", List.of(json(CONTEXT)));
        return client.getGather().annotation(RESOURCE, ANNOTATION).awaitFuture().get(10, SECONDS).getResponse();
    }

    private static TextQuoteSelector quote() {
        return TextQuoteSelector.builder("hello").build();
    }

    @Test
    void frameAddsEntityTypesAndATagSchema() throws Exception {
        assertEquals("frame:add-entity-type", asked(client.getFrame().addEntityTypesFuture(List.of("Person", "Place"))));
        assertEquals("frame:add-tag-schema", asked(client.getFrame().addTagSchemaFuture(TagSchema.builder("s1", "A schema", "Its tags", "law", List.of()).build())));
    }

    @Test
    void browseAsksForEachLiveQuery() throws Exception {
        assertEquals("browse:resource-requested", asked(client.getBrowse().resource(RESOURCE).freshFuture()));
        assertEquals("browse:resources-requested", asked(client.getBrowse().resources().freshFuture()));
        assertEquals("browse:annotation-requested", asked(client.getBrowse().annotation(RESOURCE, ANNOTATION).freshFuture()));
        // The engines are asked for beside each holder's limits, in no order.
        asked(client.getBrowse().engines().freshFuture());
        assertTrue(transport.getRequestLog().stream().anyMatch(entry -> entry.getChannel().equals("browse:engines-requested")));
        assertEquals("browse:events-requested", asked(client.getBrowse().events(RESOURCE).freshFuture()));
    }

    @Test
    void browseAsksOnceForWhatIsReadOnce() throws Exception {
        assertEquals("browse:events-requested", asked(client.getBrowse().resourceEventsFuture(RESOURCE)));
        assertEquals("browse:annotation-history-requested", asked(client.getBrowse().annotationHistoryFuture(RESOURCE, ANNOTATION)));
        assertEquals("browse:directory-requested", asked(client.getBrowse().filesFuture("/", BrowseDirectoryRequestSort.Name)));
        assertEquals("browse:kb-requested", asked(client.getBrowse().kbFuture()));
    }

    @Test
    void browseReadsAResourceThroughTheContent() throws Exception {
        assertEquals(RESOURCE, assertInstanceOf(GetResourceGraph.class, read(client.getBrowse().resourceGraphFuture(RESOURCE))).getResourceId());
        assertEquals(RESOURCE, assertInstanceOf(GetAnchoredText.class, read(client.getBrowse().resourceAnchoredTextFuture(RESOURCE))).getResourceId());
        assertEquals(RESOURCE, assertInstanceOf(GetBinary.class, read(client.getBrowse().resourceRepresentationFuture(RESOURCE))).getResourceId());
        assertEquals(RESOURCE, assertInstanceOf(GetBinaryStream.class, read(client.getBrowse().resourceRepresentationStreamFuture(RESOURCE))).getResourceId());
    }

    @Test
    void browseSignalsThisViewerAndReportsWhatItViews() throws Exception {
        assertEquals("browse:click", said("browse:click", () -> client.getBrowse().click(ANNOTATION)).getChannel());
        assertEquals("browse:resource-open", said("browse:resource-open", () -> client.getBrowse().openResource(RESOURCE)).getChannel());
        client.getBrowse().resourceViewed(RESOURCE);
        assertTrue(sent("browse:resource-viewed"));
    }

    @Test
    void markAsksForEachChangeOfAnAnnotationOrAResource() throws Exception {
        CreateAnnotationRequest request = CreateAnnotationRequest.builder(Motivation.Highlighting, AnnotationTarget.builder(RESOURCE).build()).build();
        assertEquals("mark:create-request", asked(client.getMark().annotationFuture(request)));
        assertEquals("mark:delete", asked(client.getMark().deleteFuture(RESOURCE, ANNOTATION)));
        assertEquals("mark:archive", asked(client.getMark().archiveFuture(RESOURCE)));
        assertEquals("mark:unarchive", asked(client.getMark().unarchiveFuture(RESOURCE)));
        assertEquals("mark:update-entity-types", asked(client.getMark().updateEntityTypesFuture(RESOURCE, List.of("Person"), List.of())));
    }

    @Test
    void markSignalsThisViewer() throws Exception {
        assertEquals("mark:requested", said("mark:requested", () -> client.getMark().request(RESOURCE, quote(), Motivation.Highlighting)).getChannel());
        assertEquals("mark:submit", said("mark:submit", () -> client.getMark().submit(MarkSubmitEvent.builder(RESOURCE, Motivation.Highlighting, quote()).build())).getChannel());
        assertEquals("mark:delete-error", said("mark:delete-error", () -> client.getMark().reportDeleteError(ResourceErrorEvent.builder(RESOURCE, "it failed").build())).getChannel());
    }

    @Test
    void bindAsksForABodyAndSignalsThisViewer() throws Exception {
        assertEquals("bind:update-body", asked(client.getBind().bodyFuture(RESOURCE, ANNOTATION, List.of())));
        assertEquals("bind:initiate", said("bind:initiate", () -> client.getBind().initiate(BindInitiateCommand.builder(ANNOTATION, RESOURCE, "A title", List.of()).build())).getChannel());
        assertEquals("bind:body-error", said("bind:body-error", () -> client.getBind().reportBodyError(ResourceErrorEvent.builder(RESOURCE, "it failed").build())).getChannel());
    }

    @Test
    void gatherAsksForAResourcesContextAndWhatRefersToIt() throws Exception {
        assertEquals("gather:resource-requested", asked(client.getGather().resourceFuture(RESOURCE, 1, 1, false, false, List.of())));
        assertEquals("gather:referenced-by-requested", asked(client.getGather().referencedBy(RESOURCE).freshFuture()));
    }

    @Test
    void matchSearchesAndSignalsASearch() throws Exception {
        GatheredContext context = gathered();
        assertEquals("match:search-requested", asked(client.getMatch().search(RESOURCE, ANNOTATION, context).awaitFuture()));
        assertEquals("match:resources-requested", asked(client.getMatch().resources("paris").freshFuture()));
        Frame requested = said("match:search-requested", () -> client.getMatch().requestSearch(MatchSearchRequest.builder(RESOURCE, ANNOTATION, context).build(), "search-1"));
        assertEquals("search-1", requested.getCorrelationId());
    }

    @Test
    void systemAndAuthCallTheGatewaysOwnOperations() throws Exception {
        assertEquals("healthCheck", called(client.getSystem().healthCheckFuture()));
        assertEquals("getStatus", called(client.getSystem().statusFuture()));
        assertEquals("getCurrentUser", called(client.getAuth().meFuture()));
        assertEquals("getMediaToken res-1", called(client.getAuth().mediaTokenFuture(RESOURCE)));
        assertEquals("getProtectedResourceMetadata", called(client.getAuth().protectedResourceMetadataFuture()));
    }

    @Test
    void yieldAsksForACloneAndSignalsOne() throws Exception {
        assertEquals("yield:clone-token-requested", asked(client.getYield().cloneTokenFuture(RESOURCE)));
        assertEquals("yield:clone-resource-requested", asked(client.getYield().fromTokenFuture("tok-1")));
        assertEquals("yield:clone", said("yield:clone", () -> client.getYield().clone()).getChannel());
    }

    @Test
    void beckonDrivesTheOthersAndSparklesHere() throws Exception {
        client.getBeckon().attentionFuture(RESOURCE).get(10, SECONDS);
        assertTrue(sent("beckon:focus"));
        client.getBeckon().clickFuture(ANNOTATION).get(10, SECONDS);
        assertTrue(sent("browse:click"));
        client.getBeckon().openResourceFuture(RESOURCE).get(10, SECONDS);
        assertTrue(sent("browse:resource-open"));
        client.getBeckon().sparkleAllFuture(ANNOTATION).get(10, SECONDS);
        assertTrue(sent("beckon:sparkle"));
        assertEquals("beckon:sparkle", said("beckon:sparkle", () -> client.getBeckon().sparkle(ANNOTATION)).getChannel());
    }

    @Test
    void theWireSendsAChannelsPayload() throws Exception {
        client.getWire().emitFuture(Channels.BECKON_SPARKLE, BeckonSparkleEvent.builder(ANNOTATION).build(), null, null).get(10, SECONDS);
        assertTrue(sent("beckon:sparkle"));
    }

    @Test
    void jobAsksOfAJob() throws Exception {
        assertEquals("job:status-requested", asked(client.getJob().statusFuture(JOB)));
        List<Object> statuses = new ArrayList<>();
        assertEquals("job:status-requested", asked(client.getJob().pollUntilCompleteFuture(JOB, 10, 1_000, statuses::add)));
        // The first ask was refused, so no status was told.
        assertEquals(List.of(), statuses);
        assertEquals("job:cancel-requested", asked(client.getJob().cancelFuture(JOB)));
    }

    @Test
    void jobReadsWhatIsQueuedReportedAndFailed() throws Exception {
        try (Typed<JobQueuedEvent> queued = client.getJob().queued();
                Typed<JobReportProgressCommand> progress = client.getJob().progress();
                Typed<JobFailCommand> failed = client.getJob().fail()) {
            CompletableFuture<Heard<JobQueuedEvent>> announced = first(queued.asPublisher());
            CompletableFuture<Heard<JobReportProgressCommand>> reported = first(progress.asPublisher());
            CompletableFuture<Heard<JobFailCommand>> failure = first(failed.asPublisher());
            transport.deliver(new Frame("job:queued", json("{\"jobId\":\"job-1\",\"jobType\":\"mark\",\"resourceId\":\"res-1\",\"userId\":\"did:web:kb.example:users:u\","
                    + "\"params\":{\"motivation\":\"highlighting\"}}"), null, (ResourceId) null, null));
            transport.deliver(new Frame("job:report-progress", json("{\"resourceId\":\"res-1\",\"jobId\":\"job-1\",\"jobType\":\"mark\",\"percentage\":50}"), null, (ResourceId) null, null));
            transport.deliver(new Frame("job:fail", json("{\"resourceId\":\"res-1\",\"jobId\":\"job-1\",\"jobType\":\"mark\",\"error\":\"it broke\"}"), null, (ResourceId) null, null));
            assertEquals(JOB, assertInstanceOf(MarkJobQueuedEvent.class, delivered(announced.get(10, SECONDS)).getPayload()).getJobId());
            assertEquals(50.0, delivered(reported.get(10, SECONDS)).getPayload().getPercentage());
            assertEquals("it broke", delivered(failure.get(10, SECONDS)).getPayload().getError());
        }
    }
}
