package semiont;

import static java.nio.charset.StandardCharsets.UTF_8;
import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.InputStreamReader;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Flow;
import kotlinx.coroutines.flow.StateFlowKt;
import org.junit.jupiter.api.Test;
import semiont.bus.Bus;
import semiont.bus.Delivered;
import semiont.bus.Operations;
import semiont.bus.Typed;
import semiont.channels.Channels;
import semiont.channels.Empty;
import semiont.http.HttpContentTransport;
import semiont.http.HttpTransport;
import semiont.identifiers.ResourceId;
import semiont.transport.Content;
import semiont.transport.ContentStream;
import semiont.transport.PutBinaryRequest;
import semiont.transport.Upload;
import semiont.types.BeckonFocusEvent;
import semiont.types.FrameAddEntityTypeCommand;
import semiont.types.StatusResponse;

/** The wire layer as a Java program calls it: a request through its future, a stream through its publisher, a request the program gives up, and content uploaded and read. */
final class WireTest {
    @Test
    void aRequestRoundTripsThroughItsFuture() throws Exception {
        try (Gateway gateway = new Gateway(); HttpTransport transport = new HttpTransport(gateway.origin(), StateFlowKt.MutableStateFlow("token"))) {
            gateway.answer = body -> "{\"channel\":\"frame:entity-type-add-ok\",\"payload\":{},\"correlationId\":\"" + Gateway.correlationOf(body) + "\"}";
            Empty added = new Bus(transport).requestFuture(Operations.FRAME_ADD_ENTITY_TYPE, FrameAddEntityTypeCommand.builder("Person").build(), 5_000).get(10, SECONDS);
            assertSame(Empty.INSTANCE, added);
            assertTrue(gateway.next().contains("\"payload\":{\"tag\":\"Person\"}"));
        }
    }

    @Test
    void aStreamIsReadThroughItsPublisher() throws Exception {
        try (Gateway gateway = new Gateway(); HttpTransport transport = new HttpTransport(gateway.origin(), StateFlowKt.MutableStateFlow("token"))) {
            CompletableFuture<Delivered<BeckonFocusEvent>> first = new CompletableFuture<>();
            try (Typed<BeckonFocusEvent> focus = new Bus(transport).frames(Channels.BECKON_FOCUS)) {
                focus.asPublisher().subscribe(new Flow.Subscriber<>() {
                    @Override
                    public void onSubscribe(Flow.Subscription subscription) {
                        subscription.request(1);
                    }

                    @Override
                    public void onNext(Delivered<BeckonFocusEvent> delivered) {
                        first.complete(delivered);
                    }

                    @Override
                    public void onError(Throwable error) {
                        first.completeExceptionally(error);
                    }

                    @Override
                    public void onComplete() {}
                });
                gateway.send("{\"channel\":\"beckon:focus\",\"payload\":{\"resourceId\":\"res-1\"}}");
                assertEquals(new ResourceId("res-1"), first.get(10, SECONDS).getPayload().getResourceId());
            }
        }
    }

    @Test
    void aRequestCancelledFromJavaClosesItsConnection() throws Exception {
        try (ServerSocket server = new ServerSocket(0, 0, InetAddress.getLoopbackAddress());
                HttpTransport transport = new HttpTransport("http://127.0.0.1:" + server.getLocalPort(), StateFlowKt.<String>MutableStateFlow(null))) {
            CompletableFuture<StatusResponse> status = transport.getStatusFuture();
            try (Socket asked = server.accept();
                    BufferedReader request = new BufferedReader(new InputStreamReader(asked.getInputStream(), UTF_8))) {
                asked.setSoTimeout(10_000);
                for (String line = request.readLine(); line != null && !line.isEmpty(); line = request.readLine()) {
                    // The request's head, read whole before it is given up.
                }
                status.cancel(true);
                assertTrue(status.isCancelled());
                // Given up, the request's connection is closed: the server reads its end.
                assertEquals(-1, request.read());
            }
        }
    }

    @Test
    void anUploadIsBuiltAndAwaitedFromJava() throws Exception {
        try (Gateway gateway = new Gateway();
                HttpTransport transport = new HttpTransport(gateway.origin(), StateFlowKt.<String>MutableStateFlow(null));
                HttpContentTransport content = new HttpContentTransport(transport)) {
            PutBinaryRequest request = PutBinaryRequest.builder("Notes", "the bytes".getBytes(UTF_8), "text/plain", "file://notes.txt")
                    .language("en")
                    .entityTypes(List.of("Concept"))
                    .sourceResourceId(new ResourceId("res-1"))
                    .build();
            assertEquals(request, PutBinaryRequest.builder("Notes", "the bytes".getBytes(UTF_8), "text/plain", "file://notes.txt")
                    .language("en").entityTypes(List.of("Concept")).sourceResourceId(new ResourceId("res-1")).build());
            try (Upload upload = content.putBinary(request)) {
                assertEquals(new ResourceId("res-2"), upload.awaitFuture().get(10, SECONDS).getResourceId());
            }
            String sent = new String(gateway.uploaded.get(10, SECONDS), UTF_8);
            assertTrue(sent.contains("the bytes") && sent.contains("Concept") && sent.contains("res-1"), sent);
        }
    }

    @Test
    void aResourcesBytesAreReadWholeAndThroughAPublisherFromJava() throws Exception {
        try (Gateway gateway = new Gateway();
                HttpTransport transport = new HttpTransport(gateway.origin(), StateFlowKt.<String>MutableStateFlow(null));
                HttpContentTransport content = new HttpContentTransport(transport)) {
            Content whole = content.getBinaryFuture(new ResourceId("res-1")).get(10, SECONDS);
            assertEquals("text/plain", whole.getContentType());
            assertEquals("the bytes", new String(whole.getBytes(), UTF_8));

            ContentStream stream = content.getBinaryStreamFuture(new ResourceId("res-1")).get(10, SECONDS);
            ByteArrayOutputStream read = new ByteArrayOutputStream();
            CompletableFuture<Void> ended = new CompletableFuture<>();
            stream.asPublisher().subscribe(new Flow.Subscriber<>() {
                @Override
                public void onSubscribe(Flow.Subscription subscription) {
                    subscription.request(Long.MAX_VALUE);
                }

                @Override
                public void onNext(byte[] piece) {
                    read.writeBytes(piece);
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
            ended.get(10, SECONDS);
            assertEquals("the bytes", read.toString(UTF_8));
        }
    }
}
