package semiont;

import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertInstanceOf;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import org.junit.jupiter.api.Test;
import semiont.discovery.Absent;
import semiont.discovery.DiscoveryAbsentReason;
import semiont.discovery.DiscoveryKt;
import semiont.discovery.DiscoveryTransport;
import semiont.discovery.Managed;
import semiont.http.AuthorizationKt;
import semiont.http.HttpSessionFactory;
import semiont.identifiers.ResourceId;
import semiont.registry.KbReadKind;
import semiont.registry.KbSessionStatus;
import semiont.registry.KeepingKt;
import semiont.registry.OpenKt;
import semiont.registry.OpenResource;
import semiont.registry.SemiontBrowser;
import semiont.registry.SemiontBrowserConfig;
import semiont.registry.StoredKt;
import semiont.registry.StoredSession;
import semiont.registry.TabCheck;
import semiont.registry.TabVerdict;
import semiont.session.SessionEndReason;
import semiont.session.SessionEnded;
import semiont.session.SessionSignals;
import semiont.storage.MemoryStorage;

/**
 * The registry of knowledge bases, discovery and a redirect sign-in as a Java
 * program calls them: a registry held and read, what may be nothing read as
 * an Optional, what it keeps, what is open, the session's signals, a
 * launcher's document, and the challenge a sign-in sends.
 */
final class RegistryTest {
    /** The first thing `publisher` gives. */
    private static <T> CompletableFuture<T> first(Flow.Publisher<T> publisher) {
        CompletableFuture<T> given = new CompletableFuture<>();
        publisher.subscribe(new Flow.Subscriber<>() {
            private Flow.Subscription subscription;

            @Override
            public void onSubscribe(Flow.Subscription subscription) {
                this.subscription = subscription;
                subscription.request(1);
            }

            @Override
            public void onNext(T item) {
                given.complete(item);
                subscription.cancel();
            }

            @Override
            public void onError(Throwable failure) {
                given.completeExceptionally(failure);
            }

            @Override
            public void onComplete() {
                given.completeExceptionally(new AssertionError("ended with nothing given"));
            }
        });
        return given;
    }

    @Test
    void aRegistryIsHeldAndReadFromJava() throws Exception {
        try (SemiontBrowser browser = new SemiontBrowser(new SemiontBrowserConfig(new MemoryStorage(), new HttpSessionFactory()))) {
            assertEquals(List.of(), browser.getKbs().getValue());
            assertNull(browser.getActiveKbId().getValue());
            // A value that may be nothing reaches Java as an Optional.
            assertEquals(Optional.empty(), first(browser.getActiveKbId().asPublisher()).get(10, SECONDS));
            browser.setIdentityToken("an-identity-token");
            assertEquals(Optional.of("an-identity-token"), first(browser.getIdentityToken().asPublisher()).get(10, SECONDS));
            assertEquals(KbSessionStatus.SignedOut, browser.kbSessionStatus("kb-a"));
            // Nothing is opened without a live session, and with none there is nothing to ask.
            browser.addOpenResource(new ResourceId("res-1"), "One");
            assertEquals(List.of(), browser.getOpenResources().getValue());
            assertEquals(KbReadKind.NoVerdict, browser.readActiveKbFuture().get(10, SECONDS).getKind());
        }
    }

    @Test
    void whatARegistryKeepsIsWrittenAndReadFromJava() {
        MemoryStorage storage = new MemoryStorage();
        StoredSession session = new StoredSession("an-access-token", "a-refresh-token", "semiont-browser", "https://issuer.test/token", null);
        KeepingKt.storeSession(storage, "kb-a", session);
        assertEquals(session, KeepingKt.storedSession(storage, "kb-a"));
        assertEquals("kb-a", StoredKt.kbOfSessionKey(StoredKt.sessionKey("kb-a")));
        assertEquals("semiont.knowledgeBases", StoredKt.KNOWLEDGE_BASES_KEY);
        KeepingKt.clearStoredSession(storage, "kb-a");
        assertNull(KeepingKt.storedSession(storage, "kb-a"));
    }

    @Test
    void whatIsOpenIsOrderedAndCheckedFromJava() {
        OpenResource later = new OpenResource(new ResourceId("later"), "Later", 20, 1, "text/plain", null);
        OpenResource first = new OpenResource(new ResourceId("first"), "First", 30, 0, null, null);
        List<OpenResource> ordered = OpenKt.sortOpenResources(List.of(later, first));
        assertEquals(List.of(first, later), ordered);
        List<OpenResource> kept = OpenKt.applyTabChecks(ordered, Map.of(
                new ResourceId("first"), new TabCheck(TabVerdict.Gone),
                new ResourceId("later"), new TabCheck(TabVerdict.Ready, "Its name now")));
        assertEquals(1, kept.size());
        assertEquals("Its name now", kept.get(0).getName());
        assertEquals("text/plain", kept.get(0).getMediaType());
    }

    @Test
    void theSessionsSignalsAreReadFromJava() throws Exception {
        try (SessionSignals signals = new SessionSignals()) {
            assertEquals(Optional.empty(), first(signals.getSessionEnded().asPublisher()).get(10, SECONDS));
            signals.notifySessionEnded(SessionEndReason.EXPIRED);
            assertEquals(Optional.of(new SessionEnded(SessionEndReason.EXPIRED)), first(signals.getSessionEnded().asPublisher()).get(10, SECONDS));
            signals.acknowledgeSessionEnded();
            assertNull(signals.getSessionEnded().getValue());
        }
    }

    @Test
    void aLaunchersDocumentIsReadFromJava() throws Exception {
        assertEquals(new Managed(List.of()), DiscoveryKt.parseDiscoveryDocument("{\"version\":1,\"kbs\":[]}"));
        Absent absent = assertInstanceOf(Absent.class, DiscoveryKt.parseDiscoveryDocument("not json"));
        assertEquals(DiscoveryAbsentReason.NotJson, absent.getReason());
        assertEquals(new Absent(DiscoveryAbsentReason.NotFound), new Absent(DiscoveryAbsentReason.NotFound, null));
        DiscoveryTransport text = DiscoveryKt.textDiscovery(() -> "{\"version\":1,\"kbs\":[]}");
        assertEquals(new Managed(List.of()), text.readFuture().get(10, SECONDS));
    }

    @Test
    void aSignInsChallengeIsMadeFromJava() {
        assertEquals("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM", AuthorizationKt.codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"));
    }
}
