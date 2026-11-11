using Semiont.Protocol;
using Semiont.Errors;
using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Semiont.Identifiers;
using Semiont.Serialization;
using Semiont.Types;

namespace Semiont.Http;

public enum ConnectionState { Connecting, Open, Reconnecting, Degraded, Unauthenticated, Closed }

public sealed partial class HttpTransport : IDisposable
{
    private const string IdempotencyKey = "Idempotency-Key";
    private readonly object gate = new();
    private readonly HttpClient? client;
    private readonly HttpMessageInvoker? owned;
    private readonly Timing timing;
    private readonly TimeProvider clock;
    private readonly Random random;
    private readonly Func<string?, CancellationToken, Task<string?>>? refresher;
    private readonly string[] channels;
    private readonly string clientId = Guid.NewGuid().ToString();
    private readonly CancellationTokenSource lifetime = new();
    private readonly Channel<Change> changed = Channel.CreateUnbounded<Change>();
    private readonly Broadcast<ConnectionState> states = new(replayLatest: true);
    private readonly Broadcast<SemiontError> failures = new(keepForFirst: true);
    private readonly List<FrameView> listeners = [];
    private readonly List<EventBus> buses = [];
    private readonly Dictionary<string, Pending> pending = [];
    private readonly Dictionary<string, int> holds = [];
    private readonly Dictionary<string, string> watermarks = [];
    private readonly Queue<string> remembered = [];
    private readonly HashSet<string> seen = [];
    private readonly SemaphoreSlim sendOrder = new(1, 1);
    // The schema each operation's failure channel is read as, by its channel. The required-shape table is read here, as
    // the transport is made and as the protocol's other tables are, so a table that cannot be read, or that does not
    // state a failure's schema, fails the transport's making and not its first failure.
    private readonly Dictionary<string, string> failureSchemas = ProtocolFacts.Operations()
        .Select(operation => operation.Failure).Distinct(StringComparer.Ordinal)
        .ToDictionary(failure => failure, failure => Required.Stated(ProtocolFacts.PayloadSchema(failure)), StringComparer.Ordinal);
    private Task<string?>? renewing;
    private string? renewingToken;
    private TaskCompletionSource attached = NewCompletion();
    private string? token;
    private string? refusedToken;
    private bool closed;
    private long receivedSequence;
    private ConnectionState state;
    private long outages;

    public HttpTransport(string baseUrl, string? token, IEnumerable<string>? channels = null, Timing? timing = null,
        Func<string?, CancellationToken, Task<string?>>? refresher = null, HttpClient? httpClient = null,
        TimeProvider? timeProvider = null, Random? random = null)
    {
        BaseUrl = baseUrl.TrimEnd('/');
        this.token = token;
        this.channels = (channels ?? ProtocolFacts.Channels("everyone")).Distinct(StringComparer.Ordinal).ToArray();
        this.timing = timing ?? new Timing();
        clock = timeProvider ?? TimeProvider.System;
        this.random = random ?? Random.Shared;
        this.refresher = refresher;
        client = httpClient;
        if (httpClient is null)
        {
            // HttpMessageInvoker has no global timeout: each request owns its deadline.
            owned = new HttpMessageInvoker(new SocketsHttpHandler { UseProxy = false });
        }
        Transition(ConnectionState.Connecting);
        _ = RunAsync();
    }

    internal TimeProvider Clock => clock;
    internal Timing Settings => timing;
    internal CancellationToken Closed => lifetime.Token;

    public string BaseUrl { get; }
    public ConnectionState State { get { lock (gate) { return state; } } }
    public IAsyncEnumerable<ConnectionState> States(CancellationToken cancellation = default) => states.Observe(cancellation);
    public IAsyncEnumerable<SemiontError> Errors(CancellationToken cancellation = default) => failures.Observe(cancellation);

    /// <summary>Hands <paramref name="to"/> each failure as the transport meets it, a reader of <see cref="Errors"/> as any
    /// other is, until the relay is disposed or the transport closes.</summary>
    internal IDisposable RelayFailures(Action<SemiontError> to) => failures.Relay(to);

    public void SetToken(string? value)
    {
        lock (gate)
        {
            if (token == value || closed) return;
            token = value;
            refusedToken = null;
        }
        if (value is null || State != ConnectionState.Open) changed.Writer.TryWrite(Change.Debounced);
    }

    public bool IsSubscribed(string channel) => channels.Contains(channel, StringComparer.Ordinal);

    public IAsyncEnumerable<Carried> Frames(string channel, CancellationToken cancellation = default) => Frames([channel], cancellation);

    public IAsyncEnumerable<Carried> Frames(IEnumerable<string> channelNames, CancellationToken cancellation = default) =>
        ReceivedFrames(channelNames, null, cancellation);

    internal IAsyncEnumerable<Carried> ReceivedFrames(IEnumerable<string> channelNames, ResourceId? resource, CancellationToken cancellation)
    {
        var selected = channelNames.ToHashSet(StringComparer.Ordinal);
        foreach (var channel in selected)
        {
            if (!IsSubscribed(channel) && !ProtocolFacts.Channels("scoped").Contains(channel, StringComparer.Ordinal))
                throw BusRegistry.Unsubscribed(channel);
        }
        return ObserveFrames(selected, resource, cancellation);
    }

    internal IDisposable AttachBus(EventBus bus)
    {
        lock (gate)
            if (!closed) buses.Add(bus);
        return new Hold(() => { lock (gate) buses.Remove(bus); });
    }

    private async IAsyncEnumerable<Carried> ObserveFrames(HashSet<string> selected, ResourceId? resource, [EnumeratorCancellation] CancellationToken cancellation)
    {
        var view = new FrameView(selected);
        await using var events = view.Stream.Observe(cancellation).GetAsyncEnumerator();
        Task<bool> first;
        IDisposable? hold;
        lock (gate)
        {
            if (closed) yield break;
            hold = resource is ResourceId id ? SubscribeToResource(id) : null;
            first = events.MoveNextAsync().AsTask();
            listeners.Add(view);
        }
        using var retained = hold;
        try
        {
            if (!await first.ConfigureAwait(false)) yield break;
            do { yield return events.Current; } while (await events.MoveNextAsync().ConfigureAwait(false));
        }
        finally
        {
            lock (gate) { listeners.Remove(view); view.Stream.Close(); }
        }
    }

    public IDisposable On(string channel, Action<Carried> handler)
    {
        var cancellation = new CancellationTokenSource();
        var frames = Frames(channel, cancellation.Token);
        _ = ListenAsync();
        return new Hold(() => { cancellation.Cancel(); cancellation.Dispose(); });

        async Task ListenAsync()
        {
            try
            {
                await foreach (var carried in frames.ConfigureAwait(false))
                {
                    try { handler(carried); }
                    catch (Exception error) { failures.Publish(new TransportError(ProtocolFacts.Error(0), error.Message, inner: error)); }
                }
            }
            catch (OperationCanceledException) when (cancellation.IsCancellationRequested) { }
        }
    }

    internal void RestoreWatermarks(IReadOnlyDictionary<string, string> saved)
    {
        lock (gate)
        {
            if (closed) return;
            foreach (var (scope, id) in saved) watermarks.TryAdd(scope, id);
        }
    }

    public IDisposable SubscribeToResource(ResourceId resource)
    {
        var name = resource.Value;
        lock (gate)
        {
            ObjectDisposedException.ThrowIf(closed, this);
            var retained = holds.TryGetValue(name, out var count);
            holds[name] = count + 1;
            if (!retained) changed.Writer.TryWrite(Change.Debounced);
        }
        return new Hold(() =>
        {
            lock (gate)
            {
                if (!holds.TryGetValue(name, out var count)) return;
                if (count > 1) holds[name] = count - 1;
                else { holds[name] = 0; _ = ReleaseAfterAsync(name); }
            }
        });
    }

    public async Task<long?> EmitAsync(string channel, JsonElement payload, ResourceId? scope = null, string? correlationId = null, CancellationToken cancellation = default)
    {
        using var activity = SdkTelemetry.Start("bus.emit:{channel}", SdkTelemetry.BusTags(channel, scope), channel);
        SdkTelemetry.Sent(channel, scope);
        BusLog.Line("EMIT", channel, payload);
        try { return await SentAsync(channel, payload, scope, correlationId, cancellation).ConfigureAwait(false); }
        catch (TransportError error) { failures.Publish(error); throw; }
    }

    private async Task<long?> SentAsync(string channel, JsonElement payload, ResourceId? scope, string? correlationId, CancellationToken cancellation)
    {
        lock (gate) { if (closed) throw new TransportError(ProtocolFacts.Error(0), "The transport is closed"); }
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token);
        var body = new BusEmitRequest { Channel = channel, Payload = payload, Scope = scope, CorrelationId = correlationId, ClientId = clientId };
        var key = Guid.NewGuid().ToString();
        var cap = timing.EmitRetry.InitialDelayMs;
        var renewed = false;
        var sent = Token();
        if (string.IsNullOrEmpty(sent)) throw new TransportError(ProtocolFacts.Error(401), "No usable credential", 401);
        for (var attempt = 1; ; attempt++)
        {
            cancellation.ThrowIfCancellationRequested();
            using var request = Request(HttpMethod.Post, "/bus/emit", sent);
            request.Headers.Add(IdempotencyKey, key);
            request.Content = JsonContent.Create(body);
            using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(timing.EmitTimeoutMs), clock);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token, deadline.Token);
            HttpResponseMessage response;
            try { response = await SendAsync(request, linked.Token).ConfigureAwait(false); }
            catch (Exception error) when (error is HttpRequestException || error is OperationCanceledException && !cancellation.IsCancellationRequested)
            {
                if (lifetime.IsCancellationRequested) throw new TransportError(ProtocolFacts.Error(0), "The transport is closed");
                if (attempt >= timing.EmitRetry.Attempts) throw new TransportError(ProtocolFacts.Error(503), "Emit was not answered", inner: error);
                await Task.Delay(Retry.EqualJitter(TimeSpan.FromMilliseconds(cap), random), clock, waiting.Token).ConfigureAwait(false);
                cap = Math.Min(timing.EmitRetry.MaxDelayMs, checked(cap * 2));
                continue;
            }
            using (response)
            {
                if (response.IsSuccessStatusCode)
                {
                    try { return (await response.Content.ReadFromJsonAsync<BusEmitAccepted>(linked.Token).ConfigureAwait(false))?.Subscribers; }
                    catch (JsonException) { return null; }
                }
                var failure = await RefusalAsync(response, linked.Token).ConfigureAwait(false);
                if (failure.Code == ProtocolFacts.Error(401) && !renewed)
                {
                    renewed = true;
                    if (await RenewAsync(sent, cancellation).ConfigureAwait(false) is { } renewal) { sent = renewal; attempt = 0; cap = timing.EmitRetry.InitialDelayMs; continue; }
                }
                if (!ProtocolFacts.RetryEmit((int)response.StatusCode) || failure.Code == ProtocolFacts.Error(401) || attempt >= timing.EmitRetry.Attempts) throw failure;
                var wait = Retry.EqualJitter(TimeSpan.FromMilliseconds(cap), random);
                var stated = TimeSpan.FromMilliseconds(RetryAfter(response));
                await Task.Delay(stated > wait ? stated : wait, clock, waiting.Token).ConfigureAwait(false);
                cap = Math.Min(timing.EmitRetry.MaxDelayMs, checked(cap * 2));
            }
        }
    }

    public async Task<JsonElement?> RequestAsync(string operation, JsonElement payload, int? timeoutMs = null, CancellationToken cancellation = default)
    {
        var frame = await RequestFrameAsync(operation, payload, timeoutMs, cancellation).ConfigureAwait(false);
        return frame.Frame.Payload.TryGetProperty("response", out var value) ? value.Clone() : null;
    }

    internal async Task<ReceivedBusFrame> RequestFrameAsync(string operation, JsonElement payload, int? timeoutMs, CancellationToken cancellation)
    {
        var replies = ProtocolFacts.Operation(operation);
        foreach (var channel in BusRegistry.ReplyChannelsFor(operation))
            if (!IsSubscribed(channel)) throw BusRegistry.Unsubscribed(channel);
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(timeoutMs ?? timing.BusRequestTimeoutMs), clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, lifetime.Token, cancellation);
        var correlation = Guid.NewGuid().ToString();
        var reply = new Pending(replies.Result, replies.Failure);
        lock (gate)
        {
            if (closed) throw BusError("closed", operation);
            pending.Add(correlation, reply);
        }
        var ownsTurn = false;
        try
        {
            await sendOrder.WaitAsync(linked.Token).ConfigureAwait(false);
            ownsTurn = true;
            Task open;
            lock (gate) { open = attached.Task; }
            await open.WaitAsync(linked.Token).ConfigureAwait(false);
            await EmitAsync(operation, payload, correlationId: correlation, cancellation: linked.Token).ConfigureAwait(false);
            sendOrder.Release();
            ownsTurn = false;
            var frame = await reply.Completion.Task.WaitAsync(linked.Token).ConfigureAwait(false) switch
            {
                FrameRefusal refusal => throw new TransportError(ProtocolFacts.Error(0),
                    "a frame on " + refusal.Channel + " is not that channel's: " + new Fault(refusal.Member, refusal.Reason)),
                ReceivedBusFrame received => received,
            };
            if (frame.Frame.Channel == replies.Failure) throw Answered(replies.Failure, frame.Frame.Payload);
            return frame;
        }
        catch (OperationCanceledException) when (!cancellation.IsCancellationRequested)
        {
            throw BusError(lifetime.IsCancellationRequested ? "closed" : "timeout", operation);
        }
        finally
        {
            if (ownsTurn) sendOrder.Release();
            lock (gate) { pending.Remove(correlation); }
        }
    }

    /// <summary>What a request answered on <paramref name="channel"/>, its operation's failure channel, fails with. A
    /// failure is held to its channel's schema as a result is: one with a fault is refused, naming the fault. One the
    /// schema passes is a <see cref="BusRequestError"/> in its own words, under the code its own code becomes; the schema
    /// holds the code to no list.</summary>
    private SemiontError Answered(string channel, JsonElement failure)
    {
        if (Required.FaultOf(failureSchemas[channel], failure) is { } fault)
            return new TransportError(ProtocolFacts.Error(0), $"a payload on {channel} is not that channel's: {fault}");
        var code = failure.TryGetProperty("code", out var field) ? field.GetString() : null;
        return new BusRequestError(ProtocolFacts.Failure(code), failure.GetProperty("message").GetString()
            ?? throw new InvalidOperationException($"The schema of {channel} let a failure's message be null."));
    }

    private async Task RunAsync()
    {
        CancellationTokenSource? previous = null;
        Task? read = null;
        var cap = TimeSpan.FromMilliseconds(timing.ReconnectMs);
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                while (changed.Reader.TryRead(out _)) { }
                var sent = Token();
                if (string.IsNullOrEmpty(sent) || IsRefused(sent))
                {
                    Transition(ConnectionState.Unauthenticated);
                    await WaitChangeAsync(TimeSpan.FromMilliseconds(timing.ReconnectMs)).ConfigureAwait(false);
                    continue;
                }
                BusSubscribeRequest body;
                lock (gate)
                {
                    body = new BusSubscribeRequest
                    {
                        ClientId = clientId,
                        Global = channels,
                        PendingReplies = pending.Keys.ToArray(),
                        Scoped = holds.Keys.Select(scope => new BusSubscribeRequestScopedItem
                        {
                            Scope = ResourceId.Parse(scope),
                            Channels = ProtocolFacts.Channels("scoped"),
                            LastEventId = watermarks.TryGetValue(scope, out var id) ? id : null,
                        }).ToArray(),
                    };
                }
                if (channels.Length == 0 && body.Scoped.Count == 0)
                {
                    await WaitChangeAsync(TimeSpan.FromMilliseconds(timing.ReconnectMs)).ConfigureAwait(false);
                    continue;
                }
                using var request = Request(HttpMethod.Post, "/bus/subscribe", sent);
                request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("text/event-stream"));
                request.Content = JsonContent.Create(body);
                HttpResponseMessage response;
                using (var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(timing.StreamOpenMs), clock))
                using (var linked = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, lifetime.Token))
                {
                    try { response = await SendAsync(request, linked.Token).ConfigureAwait(false); }
                    catch (Exception error) when (error is HttpRequestException || error is OperationCanceledException && !lifetime.IsCancellationRequested)
                    {
                        Transition(ConnectionState.Reconnecting);
                        await WaitChangeAsync(Backoff(ref cap)).ConfigureAwait(false);
                        continue;
                    }
                }
                if (!response.IsSuccessStatusCode)
                {
                    using (response)
                    {
                        var error = await RefusalAsync(response, lifetime.Token).ConfigureAwait(false);
                        failures.Publish(error);
                        if (error.Code == ProtocolFacts.Error(401))
                        {
                            if (await RenewAsync(sent, lifetime.Token).ConfigureAwait(false) is null) Transition(ConnectionState.Unauthenticated);
                        }
                        else
                        {
                            Transition(ConnectionState.Reconnecting);
                            var wait = Backoff(ref cap);
                            var stated = TimeSpan.FromMilliseconds(RetryAfter(response));
                            await WaitChangeAsync(stated > wait ? stated : wait).ConfigureAwait(false);
                        }
                    }
                    continue;
                }
                var current = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                var drain = DrainAsync(response, current.Token);
                var retiring = previous;
                if (retiring is not null) _ = RetireAsync(retiring);
                previous = current;
                read = drain;
                cap = TimeSpan.FromMilliseconds(timing.ReconnectMs);
                Transition(ConnectionState.Open);
                lock (gate) { attached.TrySetResult(); }
                using var changing = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                var change = changed.Reader.ReadAsync(changing.Token).AsTask();
                var done = await Task.WhenAny(drain, change).ConfigureAwait(false);
                changing.Cancel();
                if (done == change)
                {
                    if (await change.ConfigureAwait(false) == Change.Debounced)
                        await Task.Delay(TimeSpan.FromMilliseconds(ProtocolFacts.Timing("reconnectDebounceMs").GetInt32()), clock, lifetime.Token).ConfigureAwait(false);
                }
                else
                {
                    current.Dispose();
                    previous = null;
                    lock (gate) { attached = NewCompletion(); }
                    Transition(ConnectionState.Reconnecting);
                    await WaitChangeAsync(Backoff(ref cap)).ConfigureAwait(false);
                }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        finally
        {
            previous?.Cancel();
            previous?.Dispose();
            if (read is not null) await read.ConfigureAwait(false);
        }
    }

    private async Task DrainAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        using (response)
        {
            try
            {
                using var stream = await response.Content.ReadAsStreamAsync(cancellation).ConfigureAwait(false);
                var parser = new SseParser();
                var buffer = new byte[8192];
                int count;
                while ((count = await stream.ReadAsync(buffer, cancellation).ConfigureAwait(false)) != 0)
                {
                    foreach (var message in parser.Feed(buffer.AsSpan(0, count)))
                    {
                        if (message.Event != "bus-event" || message.Data.Length == 0) continue;
                        var line = LineOf(message.Data);
                        lock (gate)
                        {
                            if (closed) return;
                            if (message.Id is string id)
                            {
                                if (!seen.Add(id)) continue;
                                remembered.Enqueue(id);
                                while (remembered.Count > timing.SeenEventIdsCount) seen.Remove(remembered.Dequeue());
                            }
                            switch (line)
                            {
                                case Line.Framed(var frame):
                                    Receive(frame, message.Id);
                                    break;
                                case Line.Refused(var refusal):
                                    Deliver(refusal);
                                    break;
                                case Line.Unaddressed(var fault):
                                    // What names no reader is told to the failure report.
                                    failures.Publish(new TransportError(ProtocolFacts.Error(0), "the stream carried what is not a frame: " + fault));
                                    break;
                            }
                        }
                    }
                }
            }
            catch (Exception error) when (error is IOException || error is HttpRequestException || error is OperationCanceledException) { }
        }
    }

    /// <summary>Takes in <paramref name="frame"/>, carried under <paramref name="id"/>, and delivers it. Called holding
    /// the gate.</summary>
    private void Receive(BusFrame frame, string? id)
    {
        // A scope's position is the last persisted event delivered on it: an id with the persisted prefix that is no
        // PersistedEventId, and an ephemeral id, leave the position before them.
        if (id is not null && frame.Scope is ResourceId scope && Required.IsPersistedEventId(JsonSerializer.SerializeToElement(id)))
            watermarks[scope.Value] = id;
        ActivityContext parent = default;
        if (frame.Payload.TryGetProperty(ProtocolFacts.TraceField, out var trace))
        {
            if (trace.ValueKind == JsonValueKind.Object && trace.TryGetProperty("traceparent", out var traceparent) && traceparent.ValueKind == JsonValueKind.String)
            {
                ActivityContext.TryParse(traceparent.GetString(), trace.TryGetProperty("tracestate", out var tracestate) && tracestate.ValueKind == JsonValueKind.String ? tracestate.GetString() : null, isRemote: true, out parent);
            }
            var payload = JsonNode.Parse(frame.Payload.GetRawText())?.AsObject() ?? throw new JsonException("Null frame payload");
            payload.Remove(ProtocolFacts.TraceField);
            frame = frame with { Payload = JsonSerializer.SerializeToElement(payload) };
        }
        using var activity = SdkTelemetry.Start("bus.recv:{channel}", SdkTelemetry.BusTags(frame.Channel, frame.Scope), frame.Channel, parent);
        BusLog.Line("RECV", frame.Channel, frame.Payload);
        Deliver(new ReceivedBusFrame(frame, parent) { EventId = id, Sequence = ++receivedSequence });
    }

    /// <summary>Gives <paramref name="carried"/> to the buses, to the readers of its channel, and to the request awaiting
    /// the reply it names on that channel. Called holding the gate.</summary>
    private void Deliver(Carried carried)
    {
        // Make the wire frame visible before a continuation can publish its derived signal.
        foreach (var bus in buses) bus.Receive(carried);
        foreach (var listener in listeners.Where(view => view.Channels.Contains(carried.Channel))) listener.Stream.Publish(carried);
        if (carried.CorrelationId is string correlation && pending.TryGetValue(correlation, out var reply) &&
            (carried.Channel == reply.Result || carried.Channel == reply.Failure)) reply.Completion.TrySetResult(carried);
    }

    /// <summary>What a <c>bus-event</c> line carried: a frame BusFrame allows; the refusal of one it does not allow, whose
    /// channel and scope name its readers; or the first fault of what names no reader.</summary>
    private closed record Line
    {
        internal sealed record Framed(BusFrame Frame) : Line;
        internal sealed record Refused(FrameRefusal Refusal) : Line;
        internal sealed record Unaddressed(Fault Fault) : Line;
    }

    /// <summary><paramref name="data"/>, held to BusFrame before it is read as a frame. A frame carries what BusFrame
    /// names, and nothing more; a refused one carries its correlation id when that can be read.</summary>
    private static Line LineOf(string data)
    {
        JsonElement value;
        try { value = JsonSerializer.Deserialize<JsonElement>(data); }
        catch (JsonException) { return new Line.Unaddressed(Fault.Undecoded); }
        if (TryFrame(value, out var frame, out var fault)) return new Line.Framed(frame);
        if (value.ValueKind != JsonValueKind.Object) return new Line.Unaddressed(fault);
        // Its channel and scope name its readers when a frame of them alone is one BusFrame allows.
        var named = new JsonObject { ["payload"] = new JsonObject() };
        foreach (var member in (string[])["channel", "scope"])
            if (value.TryGetProperty(member, out var held)) named[member] = JsonNode.Parse(held.GetRawText());
        if (!TryFrame(JsonSerializer.SerializeToElement(named), out var readers, out _)) return new Line.Unaddressed(fault);
        // Its correlation id can be read when a frame of it and its readers alone is one BusFrame allows.
        string? correlationId = null;
        if (value.TryGetProperty("correlationId", out var correlation))
        {
            named["correlationId"] = JsonNode.Parse(correlation.GetRawText());
            if (TryFrame(JsonSerializer.SerializeToElement(named), out var correlated, out _)) correlationId = correlated.CorrelationId;
        }
        JsonElement? payload = value.TryGetProperty("payload", out var carried) ? carried : null;
        return new Line.Refused(new FrameRefusal(readers.Channel, fault.Member, fault.Reason, payload, correlationId, readers.Scope));
    }

    /// <summary><paramref name="value"/> read as a frame, when BusFrame allows it; or its first fault.</summary>
    private static bool TryFrame(JsonElement value, [NotNullWhen(true)] out BusFrame? frame, [NotNullWhen(false)] out Fault? fault)
    {
        frame = null;
        fault = Required.FaultOf("BusFrame", value);
        if (fault is not null) return false;
        // The walk reads a null member BusFrame does not require as one the frame does not carry, and so is it read.
        var carried = value;
        if (value.EnumerateObject().Any(member => member.Value.ValueKind == JsonValueKind.Null))
        {
            var stated = new JsonObject();
            foreach (var member in value.EnumerateObject().Where(property => property.Value.ValueKind != JsonValueKind.Null))
                stated[member.Name] = JsonNode.Parse(member.Value.GetRawText());
            carried = JsonSerializer.SerializeToElement(stated);
        }
        try { frame = carried.Deserialize<BusFrame>() ?? throw new JsonException("A frame is null."); }
        catch (JsonException)
        {
            fault = Fault.Undecoded;
            return false;
        }
        return true;
    }

    /// <summary>The token to send again with in place of <paramref name="refused"/>, or null when there is none.</summary>
    private async Task<string?> RenewAsync(string refused, CancellationToken cancellation)
    {
        Task<string?> refresh;
        lock (gate)
        {
            if (token != refused) return string.IsNullOrEmpty(token) ? null : token;
            refusedToken = refused;
            if (refresher is null) return null;
            if (renewing is null || renewingToken != refused)
            {
                renewingToken = refused;
                renewing = Task.Run(async () =>
                {
                    var renewed = await refresher(refused, lifetime.Token).ConfigureAwait(false);
                    lock (gate)
                    {
                        if (token != refused) return string.IsNullOrEmpty(token) ? null : token;
                        if (string.IsNullOrEmpty(renewed) || renewed == refused) return null;
                        SetToken(renewed);
                        return renewed;
                    }
                }, lifetime.Token);
            }
            refresh = renewing;
        }
        return await refresh.WaitAsync(cancellation).ConfigureAwait(false);
    }

    private HttpRequestMessage Request(HttpMethod method, string path, string? credential)
    {
        var request = new HttpRequestMessage(method, BaseUrl + path);
        if (Activity.Current?.Id is string traceparent) request.Headers.TryAddWithoutValidation("traceparent", traceparent);
        if (Activity.Current?.TraceStateString is string tracestate) request.Headers.TryAddWithoutValidation("tracestate", tracestate);
        if (credential is not null) request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", credential);
        return request;
    }

    private Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellation) => client is not null
        ? client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellation)
        : (owned ?? throw new InvalidOperationException("No HTTP handler")).SendAsync(request, cancellation);

    private async Task<TransportError> RefusalAsync(HttpResponseMessage response, CancellationToken cancellation)
    {
        string text;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(timing.HttpRequestMs), clock);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(deadline.Token, cancellation);
        try { text = await response.Content.ReadAsStringAsync(linked.Token).ConfigureAwait(false); }
        catch (Exception error) when (error is OperationCanceledException || error is IOException) { text = ""; }
        var status = (int)response.StatusCode;
        var code = ProtocolFacts.Error(status);
        try
        {
            using var body = JsonDocument.Parse(text);
            if (status == 429 && body.RootElement.ValueKind == JsonValueKind.Object && body.RootElement.TryGetProperty("code", out var value) && value.ValueKind == JsonValueKind.String && value.GetString() == "refusal-rate") code = ProtocolFacts.Error(401);
        }
        catch (JsonException) { }
        return new TransportError(code, $"HTTP {status}: {text}", status);
    }

    private static double RetryAfter(HttpResponseMessage response) =>
        response.Headers.TryGetValues("Retry-After", out var values)
            ? ProtocolFacts.RetryAfterMilliseconds(values.FirstOrDefault()) ?? 0
            : 0;

    private string? Token() { lock (gate) { return token; } }
    private bool IsRefused(string credential) { lock (gate) { return refusedToken == credential; } }
    private static TaskCompletionSource NewCompletion() => new(TaskCreationOptions.RunContinuationsAsynchronously);
    private static BusRequestError BusError(string code, string message) => new(ProtocolFacts.BusError(code), message);
    private void Transition(ConnectionState value)
    {
        lock (gate)
        {
            if (closed && value != ConnectionState.Closed) return;
            if (value == ConnectionState.Reconnecting && state == ConnectionState.Degraded) return;
            if (state == value && state != ConnectionState.Connecting) return;
            if (value == ConnectionState.Reconnecting) _ = DegradeAsync(++outages);
            state = value;
            states.Publish(value);
        }
    }

    /// <summary>A stream that stays down is degraded once it has been reconnecting for degradedThresholdMs.</summary>
    private async Task DegradeAsync(long outage)
    {
        try { await Task.Delay(TimeSpan.FromMilliseconds(ProtocolFacts.Timing("degradedThresholdMs").GetInt32()), clock, lifetime.Token).ConfigureAwait(false); }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { return; }
        lock (gate)
        {
            if (outage != outages || state != ConnectionState.Reconnecting) return;
            state = ConnectionState.Degraded;
            states.Publish(state);
        }
    }

    /// <summary>The wait before the stream is opened again after a failure, and the cap doubled toward maxReconnectMs for the next.</summary>
    private TimeSpan Backoff(ref TimeSpan cap)
    {
        var wait = Retry.EqualJitter(cap, random);
        var limit = TimeSpan.FromMilliseconds(ProtocolFacts.Timing("maxReconnectMs").GetInt32());
        cap = cap * 2 < limit ? cap * 2 : limit;
        return wait;
    }
    private async Task ReleaseAfterAsync(string scope)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(timing.LazyRemoveMs), clock, lifetime.Token).ConfigureAwait(false);
            lock (gate)
            {
                if (holds.TryGetValue(scope, out var count) && count == 0) { holds.Remove(scope); changed.Writer.TryWrite(Change.AtOnce); }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }
    private async Task RetireAsync(CancellationTokenSource source) { try { await Task.Delay(TimeSpan.FromMilliseconds(timing.LingerMs), clock, lifetime.Token).ConfigureAwait(false); } catch (OperationCanceledException) { } source.Cancel(); source.Dispose(); }
    private async Task WaitChangeAsync(TimeSpan wait)
    {
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        var change = changed.Reader.ReadAsync(waiting.Token).AsTask();
        await Task.WhenAny(change, Task.Delay(wait, clock, waiting.Token)).ConfigureAwait(false);
        waiting.Cancel();
        lifetime.Token.ThrowIfCancellationRequested();
    }

    public void Dispose()
    {
        lock (gate)
        {
            if (closed) return;
            closed = true;
            lifetime.Cancel();
            Transition(ConnectionState.Closed);
            foreach (var listener in listeners) listener.Stream.Close();
            buses.Clear();
            failures.Close();
            states.Close();
        }
        owned?.Dispose();
    }

    /// <summary>What reopens the stream: a credential or a scope taken waits out reconnectDebounceMs, a scope let go has already waited lazyRemoveMs.</summary>
    private enum Change { Debounced, AtOnce }

    private sealed record FrameView(HashSet<string> Channels)
    {
        internal Broadcast<Carried> Stream { get; } = new();
    }

    private sealed record Pending(string Result, string Failure)
    {
        internal TaskCompletionSource<Carried> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private sealed class Hold(Action release) : IDisposable
    {
        private Action? release = release;
        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }
}
