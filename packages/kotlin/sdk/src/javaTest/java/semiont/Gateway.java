package semiont;

import static java.nio.charset.StandardCharsets.UTF_8;
import static java.util.concurrent.TimeUnit.SECONDS;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * A gateway of one stream, for a Java test: it answers a subscribe with an
 * event stream it holds open and writes there what a test gives it, accepts
 * every emit and answers it with the frame the test makes of it, takes an
 * upload, and serves a resource's bytes as plain text.
 */
final class Gateway implements AutoCloseable {
    private static final Pattern CORRELATION = Pattern.compile("\"correlationId\":\"([^\"]+)\"");

    private final ExecutorService handling = Executors.newCachedThreadPool();
    private final HttpServer server;
    private final CompletableFuture<OutputStream> stream = new CompletableFuture<>();
    final BlockingQueue<String> emitted = new LinkedBlockingQueue<>();
    final CompletableFuture<byte[]> uploaded = new CompletableFuture<>();
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
            if (frame != null) {
                try {
                    send(frame);
                } catch (Exception failed) {
                    throw new IOException(failed);
                }
            }
        });
        server.createContext("/resources", exchange -> {
            if (exchange.getRequestMethod().equals("POST")) {
                uploaded.complete(exchange.getRequestBody().readAllBytes());
                answer(exchange, 202, "application/json", "{\"resourceId\":\"res-2\"}".getBytes(UTF_8));
            } else {
                answer(exchange, 200, "text/plain", "the bytes".getBytes(UTF_8));
            }
        });
        server.setExecutor(handling);
        server.start();
    }

    private static void answer(HttpExchange exchange, int status, String type, byte[] body) throws IOException {
        exchange.getResponseHeaders().add("Content-Type", type);
        exchange.sendResponseHeaders(status, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }

    /** The key a request's emit carries, which its reply names. */
    static String correlationOf(String body) {
        Matcher found = CORRELATION.matcher(body);
        assertTrue(found.find(), body);
        return found.group(1);
    }

    String origin() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    /** The next emit's body. One that does not come within ten seconds fails the test. */
    String next() throws InterruptedException {
        String body = emitted.poll(10, SECONDS);
        assertNotNull(body, "nothing was emitted");
        return body;
    }

    /** Write a frame to the stream, once the stream is open. One that is not open within ten seconds fails the test. */
    void send(String frame) throws Exception {
        OutputStream out = stream.get(10, SECONDS);
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
