using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Semiont.Errors;
using Semiont.Protocol;
using Semiont.Types;

namespace Semiont.Testing;

/// <summary>Returns the response carried by a result, or throws a Semiont error to send a refusal.</summary>
public delegate JsonElement? Respond(string operation, JsonElement payload);

public closed record FaultAction
{
    public sealed record Deliver : FaultAction;
    public sealed record DropReply : FaultAction;
    public sealed record Delay(TimeSpan Duration) : FaultAction;
    public sealed record DuplicateReply : FaultAction;
    public sealed record RejectEmit : FaultAction;
}

public sealed record RequestLogEntry(string Operation, JsonElement Payload, string? CorrelationId, FaultAction Action);

/// <summary>A scripted HTTP gateway for the SDK's real emit and SSE transport.</summary>
public sealed class FaultyTransport(IEnumerable<FaultAction>? schedule = null, Respond? respond = null,
    TimeProvider? timeProvider = null) : HttpMessageHandler
{
    private readonly object gate = new();
    private readonly FaultAction[] faults = schedule?.ToArray() ?? [];
    private readonly Dictionary<string, Queue<JsonElement?>> queued = new(StringComparer.Ordinal);
    private readonly List<RequestLogEntry> log = [];
    private readonly HashSet<EventStream> streams = [];
    private readonly TimeProvider clock = timeProvider ?? TimeProvider.System;
    private long lastId;
    private int requests;
    private bool disposed;

    public IReadOnlyList<RequestLogEntry> RequestLog { get { lock (gate) return log.ToArray(); } }

    /// <summary>Supply a failure body to override the responder for a correlated request.</summary>
    public Func<string, JsonElement, JsonElement?>? Refusal { get; init; }

    /// <summary>Handles other HTTP endpoints, such as content, when the test scripts them.</summary>
    public Func<HttpRequestMessage, CancellationToken, Task<HttpResponseMessage>>? Other { get; init; }

    /// <summary>Queues responses ahead of the default responder. Dropping a reply still spends its response.</summary>
    public void QueueReplies(string operation, params JsonElement?[] responses)
    {
        lock (gate)
        {
            if (!queued.TryGetValue(operation, out var replies)) queued.Add(operation, replies = new());
            foreach (var response in responses) replies.Enqueue(response?.Clone());
        }
    }

    public void Deliver(BusFrame frame, string? eventId = null)
    {
        lock (gate) SendFrame(frame, eventId ?? NextEventId());
    }

    /// <summary>Ends the current subscriptions and lets the client reconnect.</summary>
    public void DropStream()
    {
        lock (gate)
            foreach (var stream in streams.ToArray()) stream.Dispose();
    }

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        var path = request.RequestUri?.AbsolutePath;
        if (path == "/bus/subscribe")
        {
            var subscription = await BodyAsync<BusSubscribeRequest>(request, cancellationToken).ConfigureAwait(false);
            lock (gate)
            {
                ObjectDisposedException.ThrowIf(disposed, this);
                var stream = new EventStream(subscription, Remove);
                streams.Add(stream);
                var content = new StreamContent(stream);
                content.Headers.ContentType = new("text/event-stream");
                return new HttpResponseMessage(HttpStatusCode.OK) { Content = content };
            }
        }
        if (path != "/bus/emit")
            return Other is { } other ? await other(request, cancellationToken).ConfigureAwait(false)
                : new HttpResponseMessage(HttpStatusCode.NotFound) { Content = JsonContent.Create(new { error = $"No response scripted for {path}." }) };

        var sent = await BodyAsync<BusEmitRequest>(request, cancellationToken).ConfigureAwait(false);
        FaultAction action;
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            action = faults.Length == 0 || sent.CorrelationId is null ? new FaultAction.Deliver() : faults[requests++ % faults.Length];
            log.Add(new(sent.Channel, sent.Payload, sent.CorrelationId, action));
        }
        if (action is FaultAction.RejectEmit)
            return new HttpResponseMessage(HttpStatusCode.BadRequest) { Content = JsonContent.Create(new { error = $"Scripted rejection of {sent.Channel}." }) };
        if (sent.CorrelationId is not null)
        {
            var frame = Reply(sent);
            if (action is not FaultAction.DropReply)
            {
                if (action is FaultAction.Delay(var duration))
                    await Task.Delay(duration, clock, cancellationToken).ConfigureAwait(false);
                lock (gate)
                {
                    var id = NextEventId();
                    SendFrame(frame, id, sent.ClientId);
                    if (action is FaultAction.DuplicateReply) SendFrame(frame, id, sent.ClientId);
                }
            }
        }
        return new HttpResponseMessage(HttpStatusCode.Accepted) { Content = JsonContent.Create(new BusEmitAccepted { Subscribers = 1 }) };
    }

    private static async Task<T> BodyAsync<T>(HttpRequestMessage request, CancellationToken cancellationToken) where T : class
    {
        var content = request.Content ?? throw new InvalidOperationException("Missing request body");
        return await content.ReadFromJsonAsync<T>(cancellationToken).ConfigureAwait(false)
            ?? throw new InvalidOperationException("Missing request payload");
    }

    private BusFrame Reply(BusEmitRequest sent)
    {
        var channels = ProtocolFacts.Operation(sent.Channel);
        var channel = channels.Result;
        JsonElement payload;
        if (Refusal?.Invoke(sent.Channel, sent.Payload) is { } refusal)
        {
            channel = channels.Failure;
            payload = refusal;
        }
        else
        {
            try
            {
                var fields = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
                foreach (var field in BusOperations.ReplyFields(sent.Channel))
                {
                    if (!sent.Payload.TryGetProperty(field, out var value))
                        throw new TransportError(ProtocolFacts.Error(0), $"The request '{sent.Channel}' lacks its reply field '{field}'.");
                    fields.Add(field, value);
                }
                if (Response(sent) is { } response) fields.Add("response", response);
                payload = JsonSerializer.SerializeToElement(fields);
            }
            catch (SemiontError error)
            {
                channel = channels.Failure;
                payload = JsonSerializer.SerializeToElement(new { code = error.Code, message = error.Message });
            }
        }
        return new BusFrame { Channel = channel, Scope = sent.Scope, CorrelationId = sent.CorrelationId, Payload = payload };
    }

    private JsonElement? Response(BusEmitRequest sent)
    {
        lock (gate)
            if (queued.TryGetValue(sent.Channel, out var replies) && replies.TryDequeue(out var queuedReply)) return queuedReply;
        return respond is { } responder ? responder(sent.Channel, sent.Payload)
            : throw new TransportError(ProtocolFacts.Error(0), $"No response scripted for '{sent.Channel}'.");
    }

    private string NextEventId() => (++lastId).ToString(System.Globalization.CultureInfo.InvariantCulture);

    private void SendFrame(BusFrame frame, string id, string? clientId = null)
    {
        var text = Encoding.UTF8.GetBytes($"id: {id}\nevent: bus-event\ndata: {JsonSerializer.Serialize(frame)}\n\n");
        foreach (var stream in streams.Where(stream => stream.Accepts(frame, clientId))) stream.WriteFrame(text);
    }

    private void Remove(EventStream stream) { lock (gate) streams.Remove(stream); }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            lock (gate)
            {
                disposed = true;
                DropStream();
            }
        }
        base.Dispose(disposing);
    }

    private sealed class EventStream(BusSubscribeRequest subscription, Action<EventStream> remove) : Stream
    {
        private readonly Channel<byte[]> chunks = Channel.CreateUnbounded<byte[]>();
        private ReadOnlyMemory<byte> current;

        internal bool Accepts(BusFrame frame, string? clientId) =>
            (clientId is null || subscription.ClientId == clientId) &&
            (subscription.Global?.Contains(frame.Channel) == true || subscription.Scoped?.Any(scope =>
                scope.Scope == frame.Scope && scope.Channels.Contains(frame.Channel)) == true);

        internal void WriteFrame(byte[] frame) => chunks.Writer.TryWrite(frame);

        public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            if (buffer.IsEmpty) return 0;
            if (current.IsEmpty)
            {
                if (!await chunks.Reader.WaitToReadAsync(cancellationToken).ConfigureAwait(false)) return 0;
                current = await chunks.Reader.ReadAsync(cancellationToken).ConfigureAwait(false);
            }
            var count = Math.Min(buffer.Length, current.Length);
            current[..count].CopyTo(buffer);
            current = current[count..];
            return count;
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing && chunks.Writer.TryComplete()) remove(this);
            base.Dispose(disposing);
        }

        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override void Flush() => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    }
}
