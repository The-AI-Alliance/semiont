package semiont;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicInteger;
import kotlinx.coroutines.flow.StateFlowKt;
import kotlinx.serialization.json.JsonElement;
import kotlinx.serialization.json.JsonElementKt;
import kotlinx.serialization.json.JsonObject;
import org.junit.jupiter.api.Test;
import semiont.errors.BusRequestErrorCode;
import semiont.http.HttpContentTransport;
import semiont.http.HttpTransport;
import semiont.identifiers.JobId;
import semiont.identifiers.ResourceId;
import semiont.jobs.ClaimRefusal;
import semiont.jobs.Claims;
import semiont.jobs.ClaimsKt;
import semiont.jobs.HeldJob;
import semiont.jobs.HeldYieldJob;
import semiont.jobs.JobFilterKt;
import semiont.jobs.RetriesKt;
import semiont.transport.Events;
import semiont.types.FailureClass;
import semiont.types.JobFilter;
import semiont.types.JobProgress;
import semiont.types.JobType;
import semiont.types.YieldJobDone;
import semiont.types.YieldJobFilter;

/**
 * A worker as a Java program writes one: claims taken over a gateway's wire,
 * each held job driven through its futures, settled once, and the claiming
 * stopped. And whether a job matches a filter, asked from Java.
 */
final class WorkerTest {
    private static final String RUNNING = "{\"status\":\"running\",\"metadata\":{\"id\":\"job-1\",\"type\":\"yield\",\"userId\":\"did:web:kb.example:users:u\","
            + "\"created\":\"2026-01-01T00:00:00.000Z\",\"retryCount\":0,\"maxRetries\":1},\"params\":{\"resourceId\":\"res-1\"},"
            + "\"startedAt\":\"2026-01-01T00:00:01.000Z\",\"progress\":{}}";

    /** A worker's client over a gateway that hands out one job and then has none pending. */
    private static final class Opened implements AutoCloseable {
        final Gateway gateway = new Gateway();
        final HttpTransport transport;
        final HttpContentTransport content;
        final SemiontClient client;
        final AtomicInteger claimed = new AtomicInteger();

        Opened() throws Exception {
            transport = new HttpTransport(gateway.origin(), StateFlowKt.<String>MutableStateFlow("token"), ClaimsKt.getJOB_CLAIM_CHANNELS());
            content = new HttpContentTransport(transport);
            client = new SemiontClient(transport, content, transport);
            gateway.answer = body -> {
                if (!body.contains("\"channel\":\"job:claim\"")) return null;
                String payload = claimed.getAndIncrement() == 0
                        ? "{\"response\":" + RUNNING + "}"
                        : "{\"message\":\"No pending job matches\",\"code\":\"none-pending\"}";
                String channel = payload.startsWith("{\"response\"") ? "job:claimed" : "job:claim-failed";
                return "{\"channel\":\"" + channel + "\",\"payload\":" + payload + ",\"correlationId\":\"" + Gateway.correlationOf(body) + "\"}";
            };
        }

        /** The next emit on `channel`, those on others passed over. */
        String next(String channel) throws InterruptedException {
            while (true) {
                String body = gateway.next();
                if (body.contains("\"channel\":\"" + channel + "\"")) return body;
            }
        }

        @Override
        public void close() {
            client.close();
            content.close();
            transport.close();
            gateway.close();
        }
    }

    /** The first thing `publisher` gives. */
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
    void aJavaWorkerClaimsHoldsAndSettlesAJob() throws Exception {
        try (Opened opened = new Opened()) {
            Claims claims = opened.client.getJob().claim(List.<JobFilter>of(YieldJobFilter.builder().build()));
            HeldJob job = claims.nextFuture().get(10, SECONDS);
            HeldYieldJob held = assertInstanceOf(HeldYieldJob.class, job);
            assertEquals(new JobId("job-1"), held.getJobId());
            assertEquals(new ResourceId("res-1"), held.getResourceId());
            assertEquals(1L, held.getAttempt());
            assertNotNull(claims.vitals().getActiveJob());

            held.startFuture().get(10, SECONDS);
            assertTrue(opened.next("job:start").contains("\"jobId\":\"job-1\""));
            held.progressFuture(JobProgress.builder(40.0).build()).get(10, SECONDS);
            assertTrue(opened.next("job:report-progress").contains("\"percentage\":40"));
            held.failFuture("the model refused", FailureClass.Deterministic, null, null).get(10, SECONDS);
            String failed = opened.next("job:fail");
            assertTrue(failed.contains("\"willRetry\":false"), failed);
            assertTrue(held.getSettled());
            assertFalse(held.getCancelled().getValue());

            // Settled, the worker claims again, and none is pending.
            opened.next("job:claim");
            assertEquals(0L, claims.vitals().getJobsCompleted());
            assertNotNull(claims.vitals().getLastFinishedAt());
            claims.stopFuture().get(10, SECONDS);
            assertNull(claims.nextFuture().get(10, SECONDS));
        }
    }

    @Test
    void aJobAJavaWorkerLetsGoOfUnsettledIsFailed() throws Exception {
        try (Opened opened = new Opened()) {
            Claims claims = opened.client.getJob().claim(List.<JobFilter>of(YieldJobFilter.builder().build()));
            HeldJob job = claims.nextFuture().get(10, SECONDS);
            job.close();
            assertTrue(opened.next("job:fail").contains("The worker let go of the job without settling it"));
            assertTrue(job.getSettled());
            claims.stopFuture().get(10, SECONDS);
        }
    }

    @Test
    void aJavaWorkerReadsWhatItWasHandedAndCompletesIt() throws Exception {
        try (Opened opened = new Opened()) {
            Claims claims = opened.client.getJob().claim(List.<JobFilter>of(YieldJobFilter.builder().build()));
            assertNull(claims.getStalled().getValue());
            HeldYieldJob held = assertInstanceOf(HeldYieldJob.class, claims.nextFuture().get(10, SECONDS));
            assertEquals(JobType.Yield, held.getJobType());
            assertNotNull(held.getParams());
            assertEquals(List.of(), held.getCompletedUnits());
            assertEquals(Map.of(), held.getUnitCursors());
            assertEquals(0L, held.getRetryCount());
            assertEquals(1L, held.getMaxRetries());
            assertNull(held.getAnnotationId());
            // The reply that handed the job over carried no trace.
            assertNull(held.getTrace());
            held.startFuture().get(10, SECONDS);
            held.checkpointFuture(List.of("unit-1"), Map.of()).get(10, SECONDS);
            assertTrue(opened.next("job:checkpoint").contains("unit-1"));
            // A batch of no annotations is no commit: nothing is sent.
            held.commitFuture(new ResourceId("res-1"), List.of()).get(10, SECONDS);
            held.completeFuture(YieldJobDone.builder(new ResourceId("res-2"), "A summary", false).build()).get(10, SECONDS);
            assertTrue(opened.next("job:complete").contains("res-2"));
            assertTrue(held.getSettled());
            claims.stopFuture().get(10, SECONDS);
        }
    }

    @Test
    void aJavaWorkerCancelsTheJobItHolds() throws Exception {
        try (Opened opened = new Opened()) {
            Claims claims = opened.client.getJob().claim(List.<JobFilter>of(YieldJobFilter.builder().build()));
            HeldJob held = claims.nextFuture().get(10, SECONDS);
            held.startFuture().get(10, SECONDS);
            held.cancelFuture(List.of(), Map.of()).get(10, SECONDS);
            assertTrue(opened.next("job:cancel").contains("\"jobId\":\"job-1\""));
            assertTrue(held.getSettled());
            claims.stopFuture().get(10, SECONDS);
        }
    }

    @Test
    void aClaimTheDispatcherRefusesIsSaidToAJavaWorker() throws Exception {
        try (Opened opened = new Opened()) {
            opened.gateway.answer = body -> body.contains("\"channel\":\"job:claim\"")
                    ? "{\"channel\":\"job:claim-failed\",\"payload\":{\"message\":\"This account may not claim\",\"code\":\"unauthorized\"},\"correlationId\":\""
                            + Gateway.correlationOf(body) + "\"}"
                    : null;
            Claims claims = opened.client.getJob().claim(List.<JobFilter>of(YieldJobFilter.builder().build()));
            try (Events<ClaimRefusal> refused = claims.refused()) {
                // The worker claims once it is asked for a job.
                CompletableFuture<HeldJob> reading = claims.nextFuture();
                ClaimRefusal refusal = first(refused.asPublisher()).get(10, SECONDS);
                reading.cancel(true);
                assertEquals(BusRequestErrorCode.Unauthorized, refusal.getCode());
                assertEquals("This account may not claim", refusal.getMessage());
            }
            claims.stopFuture().get(10, SECONDS);
        }
    }

    @Test
    void whetherAJobMatchesAFilterIsAskedFromJava() {
        JsonObject filter = new JsonObject(Map.<String, JsonElement>of("jobType", JsonElementKt.JsonPrimitive("yield")));
        JsonObject yielding = new JsonObject(Map.<String, JsonElement>of("jobType", JsonElementKt.JsonPrimitive("yield"), "params", new JsonObject(Map.of())));
        JsonObject marking = new JsonObject(Map.<String, JsonElement>of("jobType", JsonElementKt.JsonPrimitive("mark")));
        assertTrue(JobFilterKt.jobMatchesFilter(filter, yielding));
        assertFalse(JobFilterKt.jobMatchesFilter(filter, marking));
    }

    @Test
    void whetherAFailedJobRunsAgainAndWhatACommitReadsAreAskedFromJava() {
        assertTrue(RetriesKt.willRetryAfter(0, 1, FailureClass.Transient));
        assertFalse(RetriesKt.willRetryAfter(1, 1, FailureClass.Transient));
        assertFalse(RetriesKt.willRetryAfter(0, 1, FailureClass.Deterministic));
        assertTrue(ClaimsKt.getJOB_COMMIT_CHANNELS().contains("mark:commit-ok"));
    }
}
