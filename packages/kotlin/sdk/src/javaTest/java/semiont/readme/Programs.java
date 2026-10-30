package semiont.readme;

import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import kotlinx.coroutines.flow.StateFlowKt;
import semiont.SemiontClient;
import semiont.cache.CacheState;
import semiont.http.HttpContentTransport;
import semiont.http.HttpTransport;
import semiont.identifiers.AnnotationId;
import semiont.identifiers.ResourceId;
import semiont.types.Annotation;
import semiont.types.GatheredContext;
import semiont.types.GenerationJobParams;
import semiont.types.MarkDeleteCommand;
import semiont.types.YieldJobCompleteCommand;

/**
 * The README's Java programs. Each region between `// readme: <name>` and
 * `// readme: end` is a block of README.md, word for word once its indent is
 * taken off (ReadmeTest holds the two together), and each is run there.
 */
public final class Programs {
    private Programs() {}

    /** Open a client of the knowledge base at `baseUrl`, signed in with `token`. */
    public static SemiontClient connect(String baseUrl, String token) {
        // readme: connect-java
        HttpTransport transport = new HttpTransport(baseUrl, StateFlowKt.MutableStateFlow(token));
        SemiontClient client = new SemiontClient(transport, new HttpContentTransport(transport), transport);
        // readme: end
        return client;
    }

    /** Gather the context around an annotation, and delegate a summary of it as a `yield` job, waiting for its completion. */
    public static YieldJobCompleteCommand gatherThenDelegate(SemiontClient client, ResourceId resource, AnnotationId annotation)
            throws InterruptedException, ExecutionException {
        // readme: gather-then-delegate-java
        GatheredContext context = client.getGather().annotation(resource, annotation).awaitFuture().get().getResponse();
        GenerationJobParams params = GenerationJobParams.builder("A summary", "file://summary.md", context).build();
        YieldJobCompleteCommand done = client.getYield().delegate(params).awaitFuture().get();
        System.out.println("made " + done.getResult());
        // readme: end
        return done;
    }

    /** A model made through its builder: what must be stated, then a setter for each thing that may be. */
    public static MarkDeleteCommand aBuilder() {
        // readme: a-builder-java
        MarkDeleteCommand command = MarkDeleteCommand.builder(new AnnotationId("ann-1")).resourceId(new ResourceId("res-1")).build();
        // readme: end
        return command;
    }

    /** Watch a resource's annotations: each state of the live query, a failure among them as a value. */
    public static void watchingLive(SemiontClient client, ResourceId resource) {
        // readme: watching-live-java
        client.getBrowse().annotations(resource).asPublisher().subscribe(new Flow.Subscriber<CacheState<List<Annotation>>>() {
            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                subscription.request(Long.MAX_VALUE);
            }

            @Override
            public void onNext(CacheState<List<Annotation>> state) {
                if (state instanceof CacheState.Ready<List<Annotation>> ready) {
                    System.out.println(ready.getValue().size() + " annotations");
                } else if (state instanceof CacheState.Failed failed) {
                    System.out.println("not read: " + failed.getError().getMessage());
                }
            }

            @Override
            public void onError(Throwable error) {}

            @Override
            public void onComplete() {}
        });
        // readme: end
    }
}
