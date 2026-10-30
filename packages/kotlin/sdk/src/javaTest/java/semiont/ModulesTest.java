package semiont;

import static java.nio.charset.StandardCharsets.UTF_8;
import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Flow;
import java.util.concurrent.atomic.AtomicInteger;
import kotlin.Unit;
import kotlin.jvm.internal.StringCompanionObject;
import kotlinx.serialization.builtins.BuiltinSerializersKt;
import org.junit.jupiter.api.Test;
import semiont.annotations.AnchorMethod;
import semiont.annotations.AnnotationsKt;
import semiont.annotations.MatchQuality;
import semiont.annotations.QuotedText;
import semiont.annotations.ReconciledSpan;
import semiont.bus.BusKt;
import semiont.discovery.DiscoveryDiff;
import semiont.discovery.DiscoveryKt;
import semiont.discovery.DiscoveryRead;
import semiont.discovery.Unchanged;
import semiont.errors.BusRequestError;
import semiont.errors.IdentityUnverifiableError;
import semiont.errors.IdentityUnverifiableReason;
import semiont.errors.SessionError;
import semiont.errors.SessionErrorCode;
import semiont.http.AuthorizationKt;
import semiont.http.BeginAuthorizationOptions;
import semiont.http.ConnectKt;
import semiont.http.ConnectionIdentity;
import semiont.http.EndpointKt;
import semiont.http.HttpSessionFactory;
import semiont.http.IssuerEndpoints;
import semiont.http.PendingAuthorization;
import semiont.http.SessionsKt;
import semiont.identifiers.ResourceId;
import semiont.identifiers.UserId;
import semiont.registry.Expected;
import semiont.registry.KeepingKt;
import semiont.registry.SemiontBrowser;
import semiont.registry.SemiontBrowserConfig;
import semiont.registry.SessionFactoryOptions;
import semiont.registry.SignInOutcome;
import semiont.registry.SignedIn;
import semiont.registry.StoredKt;
import semiont.registry.StoredSession;
import semiont.retry.RetryKt;
import semiont.retry.RetryPolicy;
import semiont.session.SessionSignals;
import semiont.session.TokensKt;
import semiont.storage.MemoryStorage;
import semiont.storage.StoragePersister;
import semiont.transport.Events;
import semiont.transport.TransportKt;
import semiont.types.AgentSoftware;
import semiont.types.Annotation;
import semiont.types.AnnotationSelector;
import semiont.types.HttpEndpoint;
import semiont.types.HttpEndpointProtocol;
import semiont.types.KbDescription;
import semiont.types.KnowledgeBase;
import semiont.types.LocalEndpoint;
import semiont.types.Motivation;

/**
 * The modules a Java program reaches past the client: an annotation's
 * readers, the bus's vocabulary, discovery, a host's name, a redirect
 * sign-in, the registry's keeping, retrying, a cache's persistence and a
 * token's claims.
 */
final class ModulesTest {
    private static final ResourceId RESOURCE = new ResourceId("res-1");
    /** A gateway's endpoint, as a sign-in names it. */
    private static HttpEndpoint endpointOf(Gateway gateway) {
        return HttpEndpoint.builder("127.0.0.1", gateway.port(), HttpEndpointProtocol.Http).build();
    }

    /** Wait for `future` to fail, and give what it failed with. */
    private static Throwable failure(CompletableFuture<?> future) {
        return assertThrows(ExecutionException.class, () -> future.get(10, SECONDS)).getCause();
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

    @Test
    void anAnnotationIsReadFromJava() {
        String text = "Ada Lovelace wrote the first algorithm.";
        ReconciledSpan found = AnnotationsKt.reconcile(text, new QuotedText("Lovelace"));
        assertNotNull(found);
        Annotation highlight = AnnotationsKt.annotationOfSpan(text, found.getSpan(), RESOURCE, Motivation.Highlighting, AgentSoftware.builder().name("gemma3").build());
        assertTrue(AnnotationsKt.isHighlight(highlight));
        assertFalse(AnnotationsKt.isReference(highlight));
        assertFalse(AnnotationsKt.isAssessment(highlight));
        assertFalse(AnnotationsKt.isComment(highlight));
        assertFalse(AnnotationsKt.isTag(highlight));
        assertFalse(AnnotationsKt.isStubReference(highlight));
        assertFalse(AnnotationsKt.isResolvedReference(highlight));
        assertNull(AnnotationsKt.commentText(highlight));
        assertEquals(List.of(), AnnotationsKt.entityTypes(highlight));
        assertNull(AnnotationsKt.tagCategory(highlight));
        assertNull(AnnotationsKt.tagSchemaId(highlight));
        assertFalse(AnnotationsKt.isBodyResolved(highlight.getBody()));
        // A reader that gives an id gives Java its text: Kotlin exposes no typed form of an id a function only returns.
        assertNull(AnnotationsKt.bodySource(highlight.getBody()));
        assertEquals("res-1", AnnotationsKt.targetSource(highlight.getTarget()));
        AnnotationSelector selector = AnnotationsKt.targetSelector(highlight.getTarget());
        assertEquals("Lovelace", AnnotationsKt.textQuoteSelector(selector).getExact());
        assertEquals("Lovelace", AnnotationsKt.exactText(selector));

        Annotation tag = AnnotationsKt.annotationOfResource(RESOURCE, Motivation.Tagging);
        assertTrue(AnnotationsKt.isTag(tag));
        assertEquals("res-1", AnnotationsKt.targetSource(tag.getTarget()));
        assertEquals(MatchQuality.Fuzzy, new AnchorMethod.FuzzyMatch(MatchQuality.Fuzzy).getQuality());
    }

    @Test
    void theBussVocabularyIsReadFromJava() {
        BusRequestError refused = TransportKt.unsubscribed("job:queued");
        assertEquals("bus.unsubscribed", refused.getCode());
        assertTrue(BusKt.getPERSISTED_EVENT_TYPES().contains("mark:added"));
    }

    @Test
    void aLaunchersDocumentIsWatchedFromJava() throws Exception {
        assertTrue(DiscoveryKt.DISCOVERY_INTERVAL > 0);
        assertNotNull(semiont.http.DiscoveryKt.httpDiscovery("http://127.0.0.1:9"));
        assertInstanceOf(DiscoveryRead.class, Unchanged.INSTANCE);
        try (Events<DiscoveryDiff> diffs = DiscoveryKt.subscribeDiscovery(DiscoveryKt.textDiscovery(() -> "{\"version\":1,\"kbs\":[]}"), 10)) {
            DiscoveryDiff first = first(diffs.asPublisher()).get(10, SECONDS);
            assertEquals(List.of(), first.getAdded());
        }
    }

    @Test
    void aHostsNameIsCheckedFromJava() {
        assertTrue(EndpointKt.isValidHostname("kb.example"));
        assertFalse(EndpointKt.isValidHostname("not a host"));
    }

    @Test
    void aRedirectSignInIsBegunAndCompletedFromJava() throws Exception {
        MemoryStorage storage = new MemoryStorage();
        try (Gateway gateway = new Gateway()) {
            HttpEndpoint target = endpointOf(gateway);
            // The knowledge base names no issuer, so the sign-in cannot begin.
            assertNotNull(failure(AuthorizationKt.beginAuthorizationFuture(new BeginAuthorizationOptions(target, "kb-a"), storage)));
            assertNull(storage.get(StoredKt.PENDING_AUTHORIZATION_KEY));
            // Nothing was begun, so there is nothing to complete.
            assertNotNull(failure(AuthorizationKt.completeAuthorizationFuture("http://app.example/callback?code=c&state=s", storage)));
            // The knowledge base says what it is, and its did is made from the domain it states.
            gateway.answer = body -> body.contains("\"channel\":\"browse:kb-requested\"")
                    ? "{\"channel\":\"browse:kb-result\",\"payload\":{\"response\":{\"name\":\"A KB\",\"domain\":\"kb.example\"}},\"correlationId\":\"" + Gateway.correlationOf(body) + "\"}"
                    : null;
            ConnectionIdentity described = ConnectKt.describeConnectionFuture(target, "a-token").get(10, SECONDS);
            assertEquals(new UserId("did:web:kb.example"), described.getDid());
            assertEquals("A KB", described.getDescription().getName());
        }

        IssuerEndpoints issuer = new IssuerEndpoints("https://issuer.example", "https://issuer.example/auth", "https://issuer.example/token", null, null);
        PendingAuthorization pending = new PendingAuthorization("a-state", "a-verifier", "http://app.example/callback",
                HttpEndpoint.builder("kb.example", 443, HttpEndpointProtocol.Https).build(), issuer, "kb-a", null, null);
        assertEquals("kb-a", pending.getKbId());
        assertEquals("unreachable", new IdentityUnverifiableError(IdentityUnverifiableReason.Unreachable, "nothing answered").getReason().getCode());
    }

    @Test
    void whatTheRegistryKeepsIsReadAndWrittenFromJava() throws Exception {
        MemoryStorage storage = new MemoryStorage();
        KnowledgeBase kb = KnowledgeBase.builder("kb-a", "A KB", LocalEndpoint.builder("kb-a").build(), "did:web:kb.example").build();
        KeepingKt.saveKnowledgeBases(storage, List.of(kb));
        assertEquals(List.of(kb), KeepingKt.loadKnowledgeBases(storage));
        assertNotNull(storage.get(StoredKt.KNOWLEDGE_BASES_KEY));
        assertNull(storage.get(StoredKt.ACTIVE_KEY));
        assertNull(storage.get(StoredKt.OPEN_RESOURCES_BY_KB_KEY));
        assertNull(storage.get(StoredKt.LAST_VIEWED_RESOURCE_BY_KB_KEY));
        assertNotNull(KeepingKt.keptIn(storage, "kb-a"));

        StoredSession session = new StoredSession("an-access-token", "a-refresh-token", "semiont-browser", "https://issuer.example/token", null);
        SignedIn signedIn = new SignedIn(kb.getEndpoint(), KbDescription.builder("A KB", "kb.example").build(), session);
        assertEquals(session, signedIn.getSession());
        SignInOutcome outcome = new SignInOutcome(kb, new Expected("did:web:kb.example", "A KB"));
        assertEquals("A KB", outcome.getExpected().getName());
        try (SessionSignals signals = new SessionSignals()) {
            List<SessionError> told = new ArrayList<>();
            SessionFactoryOptions made = new SessionFactoryOptions(kb, storage, signals, error -> {
                told.add(error);
                return Unit.INSTANCE;
            });
            assertEquals(kb, made.getKb());
            // What the session the options build says of its failures reaches whoever made them.
            SessionError failed = new SessionError(SessionErrorCode.ConstructFailed, "it could not be built", "kb-a");
            made.getOnError().invoke(failed);
            assertEquals(List.of(failed), told);
        }

        try (Gateway gateway = new Gateway(); SemiontBrowser browser = new SemiontBrowser(new SemiontBrowserConfig(storage, new HttpSessionFactory()))) {
            assertNotNull(failure(SessionsKt.beginSignInFuture(browser, new BeginAuthorizationOptions(endpointOf(gateway), "kb-a"))));
            assertNotNull(failure(SessionsKt.completeSignInFuture(browser, "http://app.example/callback?code=c&state=s")));
        }
    }

    @Test
    void aRetryIsRunFromJava() throws Exception {
        AtomicInteger attempts = new AtomicInteger();
        // What is retried is a failure the SDK names: here, a stream that cannot deliver a channel.
        String done = RetryKt.retryWithBackoffFuture(new RetryPolicy(3, 1, 2), failed -> failed instanceof BusRequestError, () -> attempts.incrementAndGet() == 1
                ? CompletableFuture.<String>failedFuture(TransportKt.unsubscribed("job:queued"))
                : CompletableFuture.completedFuture("done")).get(10, SECONDS);
        assertEquals("done", done);
        assertEquals(2, attempts.get());
    }

    @Test
    void aCachesValuesAreKeptFromJava() {
        MemoryStorage storage = new MemoryStorage();
        StoragePersister<String, String> persister = new StoragePersister<>(storage, "a-cache",
                BuiltinSerializersKt.serializer(StringCompanionObject.INSTANCE), BuiltinSerializersKt.serializer(StringCompanionObject.INSTANCE), 1, 1_000_000);
        persister.save(Map.of("res-1", "its value"));
        assertEquals(Map.of("res-1", "its value"), persister.load());
    }

    @Test
    void aTokensClaimsAreReadFromJava() {
        Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
        String token = encoder.encodeToString("{\"alg\":\"none\"}".getBytes(UTF_8)) + "."
                + encoder.encodeToString("{\"sub\":\"u-1\",\"iat\":1000,\"exp\":2000}".getBytes(UTF_8)) + ".";
        assertEquals("u-1", TokensKt.textClaim(token, "sub"));
        assertEquals(2000.0, TokensKt.tokenExpiry(token));
        assertTrue(TokensKt.isTokenExpired(token, 2500));
        assertFalse(TokensKt.isTokenExpired(token, 1500));
        assertTrue(TokensKt.renewalDelay(1000, 1000) > 0);
        assertNotNull(TokensKt.refreshDelay(token, 1500));
    }
}
