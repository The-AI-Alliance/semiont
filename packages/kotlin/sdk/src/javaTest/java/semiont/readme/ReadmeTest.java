package semiont.readme;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.concurrent.CompletableFuture;
import kotlinx.serialization.json.Json;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import org.junit.jupiter.api.Test;
import semiont.SemiontClient;
import semiont.http.HttpTransport;
import semiont.identifiers.AnnotationId;
import semiont.identifiers.ResourceId;
import semiont.testing.FaultyTransport;
import semiont.testing.InMemoryContent;
import semiont.testing.TestClient;
import semiont.transport.Frame;
import semiont.types.GetAnnotationsResponse;
import semiont.types.YieldJobCompleteCommand;

/** The README's Java programs, each run as a Java program's author runs it. */
final class ReadmeTest {
    private static final String CONTEXT = "{\"focus\":{\"kind\":\"resource\",\"resource\":{\"@context\":\"https://schema.org\",\"@id\":\"res-1\",\"name\":\"A resource\","
            + "\"representations\":[]}},\"graph\":{\"nodes\":[],\"edges\":[]},\"metadata\":{}}";

    private static JsonObject json(String text) {
        return JsonElementKt.getJsonObject(Json.Default.parseToJsonElement(text));
    }

    @Test
    void connectingMakesAClientOverHttp() {
        SemiontClient client = Programs.connect("http://127.0.0.1:9", "a-token");
        assertInstanceOf(HttpTransport.class, client.getTransport());
        client.close();
        client.getTransport().close();
    }

    @Test
    void gatheringThenDelegatingWaitsForTheJobsCompletion() throws Exception {
        FaultyTransport transport = new FaultyTransport();
        TestClient made = new TestClient(transport);
        transport.queueReply("gather:requested", List.of(json(CONTEXT)));
        transport.queueReply("job:create", List.of(json("{\"jobId\":\"job-1\"}")));
        CompletableFuture<YieldJobCompleteCommand> done =
                CompletableFuture.supplyAsync(() -> {
                    try {
                        return Programs.gatherThenDelegate(made.getClient(), new ResourceId("res-1"), new AnnotationId("ann-1"));
                    } catch (Exception failed) {
                        throw new IllegalStateException(failed);
                    }
                });
        long until = System.currentTimeMillis() + 10_000;
        while (transport.getRequestLog().stream().noneMatch(entry -> entry.getChannel().equals("job:create"))) {
            assertTrue(System.currentTimeMillis() < until, "the job was never created");
            Thread.sleep(10);
        }
        transport.deliver(new Frame("job:complete",
                json("{\"resourceId\":\"res-1\",\"jobId\":\"job-1\",\"jobType\":\"yield\",\"result\":{\"resourceId\":\"res-2\",\"resourceName\":\"A summary\",\"truncated\":false}}"),
                null, (ResourceId) null, null));
        assertEquals("job-1", done.get(10, SECONDS).getJobId().getValue());
        made.getClient().close();
        transport.close();
    }

    @Test
    void aModelIsMadeThroughItsBuilder() {
        assertEquals(new AnnotationId("ann-1"), Programs.aBuilder().getAnnotationId());
    }

    @Test
    void watchingLiveReadsTheQueryThroughAPublisher() throws Exception {
        FaultyTransport transport = new FaultyTransport();
        InMemoryContent content = new InMemoryContent();
        content.seedAnnotations(new ResourceId("res-1"), GetAnnotationsResponse.builder(List.of(), 0).build());
        TestClient made = new TestClient(transport, content);
        Programs.watchingLive(made.getClient(), new ResourceId("res-1"));
        long until = System.currentTimeMillis() + 10_000;
        while (content.getCalls().isEmpty()) {
            assertTrue(System.currentTimeMillis() < until, "the query was never read");
            Thread.sleep(10);
        }
        made.getClient().close();
        transport.close();
    }
}
