package semiont;

import static java.nio.charset.StandardCharsets.UTF_8;
import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertSame;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpServer;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Flow;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import kotlinx.coroutines.flow.StateFlowKt;
import org.junit.jupiter.api.Test;
import semiont.bus.Bus;
import semiont.bus.Delivered;
import semiont.bus.Operations;
import semiont.bus.Typed;
import semiont.channels.Channels;
import semiont.channels.Empty;
import semiont.http.HttpTransport;
import semiont.identifiers.ResourceId;
import semiont.types.BeckonFocusEvent;
import semiont.types.FrameAddEntityTypeCommand;
import semiont.types.StatusResponse;

/** The wire layer as a Java program calls it: a request through its future, a stream through its publisher, and a request the program gives up. */
final class WireTest {
    private static final Pattern CORRELATION = Pattern.compile("\"correlationId\":\"([^\"]+)\"");

    /** A gateway of one stream: it answers a subscribe with an event stream it holds open, and writes there what a test gives it. */
    private static final class Gateway implements AutoCloseable {
        private final ExecutorService handling = Executors.newCachedThreadPool();
        private final HttpServer server;
        private final CompletableFuture<OutputStream> stream = new CompletableFuture<>();
        final BlockingQueue<String> emitted = new LinkedBlockingQueue<>();
        /** The frame to send back for an emit's body, or null for none. */
        volatile Function<String, String> answer = body -> null;

        Gateway() throws IOException {
            server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
            server.createContext("/bus/subscribe", exchange -> {
                exchange.getRequestBody().readAllBytes();
                exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
                exchange.sendResponseHeaders(200, 0);
                OutputStream out = exchange.getResponseBody();
                // The server sends its head with the body's first bytes: a comment, which a reader of the stream passes over.
                out.write(": open\n\n".getBytes(UTF_8));
                out.flush();
                stream.complete(out);
            });
            server.createContext("/bus/emit", exchange -> {
                String body = new String(exchange.getRequestBody().readAllBytes(), UTF_8);
                byte[] accepted = "{\"subscribers\":1}".getBytes(UTF_8);
                exchange.getResponseHeaders().add("Content-Type", "application/json");
                exchange.sendResponseHeaders(202, accepted.length);
                exchange.getResponseBody().write(accepted);
                exchange.close();
                emitted.add(body);
                String frame = answer.apply(body);
                if (frame != null) send(frame);
            });
            server.setExecutor(handling);
            server.start();
        }

        String origin() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }

        void send(String frame) throws IOException {
            OutputStream out = stream.join();
            synchronized (out) {
                out.write(("event: bus-event\ndata: " + frame + "\n\n").getBytes(UTF_8));
                out.flush();
            }
        }

        @Override
        public void close() {
            server.stop(0);
            handling.shutdownNow();
        }
    }

    private static String correlationOf(String body) {
        Matcher found = CORRELATION.matcher(body);
        assertTrue(found.find(), body);
        return found.group(1);
    }

    @Test
    void aRequestRoundTripsThroughItsFuture() throws Exception {
        try (Gateway gateway = new Gateway(); HttpTransport transport = new HttpTransport(gateway.origin(), StateFlowKt.MutableStateFlow("token"))) {
            gateway.answer = body -> "{\"channel\":\"frame:entity-type-add-ok\",\"payload\":{},\"correlationId\":\"" + correlationOf(body) + "\"}";
            Empty added = new Bus(transport).requestFuture(Operations.FRAME_ADD_ENTITY_TYPE, FrameAddEntityTypeCommand.builder("Person").build(), 5_000).get(10, SECONDS);
            assertSame(Empty.INSTANCE, added);
            assertTrue(gateway.emitted.take().contains("\"payload\":{\"tag\":\"Person\"}"));
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
            try (Socket asked = server.accept()) {
                asked.setSoTimeout(10_000);
                BufferedReader request = new BufferedReader(new InputStreamReader(asked.getInputStream(), UTF_8));
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
}
