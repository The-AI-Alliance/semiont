using Semiont.Protocol;
using Semiont.Errors;
using System.Diagnostics;
using System.Net.Http.Headers;
using System.Runtime.CompilerServices;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading.Channels;
using Semiont.Identifiers;
using Semiont.Types;

namespace Semiont.Http;

public enum ConnectionState { Connecting, Open, Reconnecting, Degraded, Unauthenticated, Closed }

public sealed partial class HttpTransport : IDisposable
{
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
    private readonly Channel<bool> changed = Channel.CreateUnbounded<bool>();
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
    private Task<bool>? renewing;
    private string? renewingToken;
    private TaskCompletionSource attached = NewCompletion();
    private string? token;
    private string? refusedToken;
    private bool closed;
    private long receivedSequence;
    private ConnectionState state;
    private DateTimeOffset? outage;

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

    public void SetToken(string? value)
    {
        lock (gate)
        {
            if (token == value || closed) return;
            token = value;
            refusedToken = null;
        }
        if (value is null || State != ConnectionState.Open) changed.Writer.TryWrite(true);
    }

    public bool IsSubscribed(string channel) => channels.Contains(channel, StringComparer.Ordinal);

    public IAsyncEnumerable<BusFrame> Frames(string channel, CancellationToken cancellation = default) => Frames([channel], cancellation);

    public IAsyncEnumerable<BusFrame> Frames(IEnumerable<string> channels, CancellationToken cancellation = default) =>
        RawFrames(ReceivedFrames(channels, null, cancellation), cancellation);

    private static async IAsyncEnumerable<BusFrame> RawFrames(IAsyncEnumerable<ReceivedBusFrame> frames,
        [EnumeratorCancellation] CancellationToken cancellation)
    {
        await foreach (var frame in frames.WithCancellation(cancellation).ConfigureAwait(false)) yield return frame.Frame;
    }

    internal IAsyncEnumerable<ReceivedBusFrame> ReceivedFrames(IEnumerable<string> channels, ResourceId? resource, CancellationToken cancellation)
    {
        var selected = channels.ToHashSet(StringComparer.Ordinal);
        foreach (var channel in selected)
        {
            if (!IsSubscribed(channel) && !ProtocolFacts.Channels("scoped").Contains(channel, StringComparer.Ordinal))
                throw BusError("unsubscribed", channel);
        }
        return ObserveFrames(selected, resource, cancellation);
    }

    internal IDisposable AttachBus(EventBus bus)
    {
        lock (gate)
            if (!closed) buses.Add(bus);
        return new Hold(() => { lock (gate) buses.Remove(bus); });
    }

    private async IAsyncEnumerable<ReceivedBusFrame> ObserveFrames(HashSet<string> selected, ResourceId? resource, [EnumeratorCancellation] CancellationToken cancellation)
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

    public async IAsyncEnumerable<JsonElement> Stream(string channel, [EnumeratorCancellation] CancellationToken cancellation = default)
    {
        await foreach (var frame in Frames(channel, cancellation).ConfigureAwait(false)) yield return frame.Payload;
    }

    public IDisposable On(string channel, Action<JsonElement> handler)
    {
        var cancellation = new CancellationTokenSource();
        var frames = Frames(channel, cancellation.Token);
        _ = ListenAsync();
        return new Hold(() => { cancellation.Cancel(); cancellation.Dispose(); });

        async Task ListenAsync()
        {
            try
            {
                await foreach (var frame in frames.ConfigureAwait(false))
                {
                    try { handler(frame.Payload); }
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
            if (!retained) changed.Writer.TryWrite(true);
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
        var cap = timing.EmitRetry.InitialDelayMs;
        var renewed = false;
        for (var attempt = 1; ; attempt++)
        {
            cancellation.ThrowIfCancellationRequested();
            var sent = Token();
            if (string.IsNullOrEmpty(sent)) throw new TransportError(ProtocolFacts.Error(401), "No usable credential", 401);
            if (IsRefused(sent))
            {
                renewed = true;
                if (!await RenewAsync(sent, cancellation).ConfigureAwait(false)) throw new TransportError(ProtocolFacts.Error(401), "No usable credential", 401);
                attempt--;
                continue;
            }
            using var request = Request(HttpMethod.Post, "/bus/emit", sent);
            request.Content = JsonContent.Create(body);
            using var deadline = new CancellationTokenSource(TimeSpan.FromMilliseconds(timing.EmitTimeoutMs), clock);
            using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellation, lifetime.Token, deadline.Token);
            HttpResponseMessage response;
            try { response = await SendAsync(request, linked.Token).ConfigureAwait(false); }
            catch (Exception error) when (error is HttpRequestException || error is OperationCanceledException && !cancellation.IsCancellationRequested)
            {
                if (lifetime.IsCancellationRequested) throw new TransportError(ProtocolFacts.Error(0), "The transport is closed");
                if (attempt >= timing.EmitRetry.Attempts) throw new TransportError(ProtocolFacts.Error(503), "Emit was not answered", inner: error);
                await Task.Delay(TimeSpan.FromMilliseconds(cap / 2d + random.NextDouble() * cap / 2d), clock, waiting.Token).ConfigureAwait(false);
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
                    if (await RenewAsync(sent, cancellation).ConfigureAwait(false)) { attempt--; continue; }
                }
                if (!ProtocolFacts.RetryEmit((int)response.StatusCode) || failure.Code == ProtocolFacts.Error(401) || attempt >= timing.EmitRetry.Attempts) throw failure;
                var delay = Math.Max(RetryAfter(response), cap / 2d + random.NextDouble() * cap / 2d);
                await Task.Delay(TimeSpan.FromMilliseconds(delay), clock, waiting.Token).ConfigureAwait(false);
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
        if (!IsSubscribed(replies.Result) || !IsSubscribed(replies.Failure)) throw BusError("unsubscribed", operation);
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
            var frame = await reply.Completion.Task.WaitAsync(linked.Token).ConfigureAwait(false);
            if (frame.Frame.Channel == replies.Failure)
            {
                string? code = frame.Frame.Payload.TryGetProperty("code", out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;
                var detail = FailureText(frame.Frame.Payload, "message") ?? FailureText(frame.Frame.Payload, "error");
                throw new BusRequestError(ProtocolFacts.Failure(code), detail ?? frame.Frame.Payload.ToString());
            }
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

    private static string? FailureText(JsonElement payload, string name) =>
        payload.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : null;

    private async Task RunAsync()
    {
        CancellationTokenSource? previous = null;
        Task? read = null;
        var wait = timing.ReconnectMs;
        try
        {
            while (!lifetime.IsCancellationRequested)
            {
                while (changed.Reader.TryRead(out _)) { }
                var sent = Token();
                if (string.IsNullOrEmpty(sent) || IsRefused(sent))
                {
                    Transition(ConnectionState.Unauthenticated);
                    await WaitChangeAsync(timing.ReconnectMs).ConfigureAwait(false);
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
                    await WaitChangeAsync(timing.ReconnectMs).ConfigureAwait(false);
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
                        await WaitChangeAsync(wait).ConfigureAwait(false);
                        wait = Math.Min(ProtocolFacts.Timing("maxReconnectMs").GetInt32(), checked(wait * 2));
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
                            if (!await RenewAsync(sent, lifetime.Token).ConfigureAwait(false)) Transition(ConnectionState.Unauthenticated);
                        }
                        else
                        {
                            Transition(ConnectionState.Reconnecting);
                            await WaitChangeAsync(Math.Max(wait, RetryAfter(response))).ConfigureAwait(false);
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
                wait = timing.ReconnectMs;
                Transition(ConnectionState.Open);
                lock (gate) { attached.TrySetResult(); }
                using var changing = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                var change = changed.Reader.ReadAsync(changing.Token).AsTask();
                var done = await Task.WhenAny(drain, change).ConfigureAwait(false);
                changing.Cancel();
                if (done == change)
                {
                    await Task.Delay(TimeSpan.FromMilliseconds(ProtocolFacts.Timing("reconnectDebounceMs").GetInt32()), clock, lifetime.Token).ConfigureAwait(false);
                }
                else
                {
                    current.Dispose();
                    previous = null;
                    lock (gate) { attached = NewCompletion(); }
                    Transition(ConnectionState.Reconnecting);
                    await WaitChangeAsync(wait).ConfigureAwait(false);
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
                        if (message.Event != "bus-event") continue;
                        BusFrame? frame;
                        try { frame = JsonSerializer.Deserialize<BusFrame>(message.Data); }
                        catch (JsonException) { continue; }
                        if (frame is null) continue;
                        lock (gate)
                        {
                            if (closed) return;
                            if (message.Id is string id)
                            {
                                if (!seen.Add(id)) continue;
                                remembered.Enqueue(id);
                                while (remembered.Count > timing.SeenEventIdsCount) seen.Remove(remembered.Dequeue());
                                if (id.StartsWith("p-", StringComparison.Ordinal) && frame.Scope is ResourceId scope) watermarks[scope.Value] = id;
                            }
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
                            var received = new ReceivedBusFrame(frame, parent) { EventId = message.Id, Sequence = ++receivedSequence };
                            // Make the wire frame visible before a continuation can publish its derived signal.
                            foreach (var bus in buses) bus.Receive(received);
                            foreach (var listener in listeners)
                                if (listener.Channels.Contains(frame.Channel)) listener.Stream.Publish(received);
                            if (frame.CorrelationId is string correlation && pending.TryGetValue(correlation, out var reply) &&
                                (frame.Channel == reply.Result || frame.Channel == reply.Failure)) reply.Completion.TrySetResult(received);
                        }
                    }
                }
            }
            catch (Exception error) when (error is IOException || error is HttpRequestException || error is OperationCanceledException) { }
        }
    }

    private async Task<bool> RenewAsync(string refused, CancellationToken cancellation)
    {
        Task<bool> refresh;
        lock (gate)
        {
            if (token != refused) return !string.IsNullOrEmpty(token);
            refusedToken = refused;
            if (refresher is null) return false;
            if (renewing is null || renewingToken != refused)
            {
                renewingToken = refused;
                renewing = Task.Run(async () =>
                {
                    var renewed = await refresher(refused, lifetime.Token).ConfigureAwait(false);
                    lock (gate)
                    {
                        if (token != refused) return !string.IsNullOrEmpty(token);
                        if (string.IsNullOrEmpty(renewed) || renewed == refused) return false;
                        SetToken(renewed);
                        return true;
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
            if (value == ConnectionState.Reconnecting)
            {
                outage ??= clock.GetUtcNow();
                if ((clock.GetUtcNow() - outage.Value).TotalMilliseconds >= ProtocolFacts.Timing("degradedThresholdMs").GetInt32()) value = ConnectionState.Degraded;
            }
            else if (value != ConnectionState.Degraded) outage = null;
            if (state == value && state != ConnectionState.Connecting) return;
            state = value;
            states.Publish(value);
        }
    }
    private async Task ReleaseAfterAsync(string scope)
    {
        try
        {
            await Task.Delay(TimeSpan.FromMilliseconds(timing.LazyRemoveMs), clock, lifetime.Token).ConfigureAwait(false);
            lock (gate)
            {
                if (holds.TryGetValue(scope, out var count) && count == 0) { holds.Remove(scope); changed.Writer.TryWrite(true); }
            }
        }
        catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
    }
    private async Task RetireAsync(CancellationTokenSource source) { try { await Task.Delay(TimeSpan.FromMilliseconds(timing.LingerMs), clock, lifetime.Token).ConfigureAwait(false); } catch (OperationCanceledException) { } source.Cancel(); source.Dispose(); }
    private async Task WaitChangeAsync(double ms)
    {
        using var waiting = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
        var change = changed.Reader.ReadAsync(waiting.Token).AsTask();
        await Task.WhenAny(change, Task.Delay(TimeSpan.FromMilliseconds(ms), clock, lifetime.Token)).ConfigureAwait(false);
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

    private sealed record FrameView(HashSet<string> Channels)
    {
        internal Broadcast<ReceivedBusFrame> Stream { get; } = new();
    }

    private sealed record Pending(string Result, string Failure)
    {
        internal TaskCompletionSource<ReceivedBusFrame> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
    private sealed class Hold(Action release) : IDisposable
    {
        private Action? release = release;
        public void Dispose() => Interlocked.Exchange(ref release, null)?.Invoke();
    }
}
